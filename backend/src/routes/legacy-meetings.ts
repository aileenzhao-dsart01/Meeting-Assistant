/**
 * Legacy route wrappers — these replicate the original flat routes at
 * `/api/meetings` so that existing API consumers continue to work once
 * they pass an auth header.
 *
 * Every handler resolves the user's default (first-joined) workspace and
 * delegates to the same query logic as the workspace-scoped routes.
 *
 * NOTE: These routes are DEPRECATED. New code should use the
 * `/api/workspaces/:wid/meetings/*` paths directly.
 */

import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { requireAuth } from "../middleware/auth";
import { getStorageProvider } from "../services/storage";
import { LlmOverride } from "../services/summarizer";
import path from "path";
import fs from "fs";
import multer from "multer";
import { config } from "../config";
import { AppError, Errors } from "../utils/errors";

export const legacyMeetingRoutes = Router();

// ---------- Helpers ----------

const MIME_TYPES: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".webm": "audio/webm",
  ".mp4": "audio/mp4",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".aiff": "audio/aiff",
  ".flac": "audio/flac",
};

function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

/** Resolve the authenticated user's default workspace. */
async function defaultWorkspace(userId: string): Promise<string> {
  const membership = await prisma.workspaceMember.findFirst({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
  if (!membership) throw Errors.forbidden("No workspace found for this user");
  return membership.workspaceId;
}

const tmpStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const tmpDir = path.resolve(config.audio.storagePath, ".upload-tmp");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    cb(null, tmpDir);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${uniqueSuffix}${path.extname(file.originalname)}`);
  },
});
const upload = multer({
  storage: tmpStorage,
  limits: { fileSize: 200 * 1024 * 1024 },
});

// All legacy routes require auth
legacyMeetingRoutes.use(requireAuth);

// ---------- GET /api/meetings ----------
legacyMeetingRoutes.get("/", async (req: Request, res: Response) => {
  try {
    const wid = await defaultWorkspace(req.user!.id);
    const { status, page = "1", limit = "20" } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const sharedMeetingIds = (
      await prisma.sharedMeeting.findMany({
        where: { workspaceId: wid },
        select: { meetingId: true },
      })
    ).map((s) => s.meetingId);

    const whereStatus = status ? { status: status as string } : {};

    const [meetings, total] = await Promise.all([
      prisma.meeting.findMany({
        where: {
          OR: [
            { workspaceId: wid, ...whereStatus },
            { id: { in: sharedMeetingIds }, ...whereStatus },
          ],
        },
        skip,
        take,
        orderBy: { createdAt: "desc" },
        include: { _count: { select: { tasks: true } } },
      }),
      prisma.meeting.count({
        where: {
          OR: [
            { workspaceId: wid, ...whereStatus },
            { id: { in: sharedMeetingIds }, ...whereStatus },
          ],
        },
      }),
    ]);

    res.json({
      success: true,
      data: {
        meetings: meetings.map((m: any) => ({
          id: m.id,
          title: m.title,
          date: m.date instanceof Date ? m.date.toISOString() : m.date,
          duration: m.duration,
          status: m.status,
          taskCount: m._count?.tasks ?? 0,
          workspaceId: m.workspaceId,
        })),
        total,
        page: parseInt(page as string),
        limit: take,
      },
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    res.status(500).json({ success: false, error: "Failed to list meetings" });
  }
});

// ---------- POST /api/meetings ----------
legacyMeetingRoutes.post("/", async (req: Request, res: Response) => {
  try {
    const wid = await defaultWorkspace(req.user!.id);
    const { title } = req.body;
    if (!title || typeof title !== "string") {
      res.status(400).json({ success: false, error: "Title is required" });
      return;
    }

    const meeting = await prisma.meeting.create({
      data: { title, workspaceId: wid, status: "pending" },
    });

    res.status(201).json({
      success: true,
      data: {
        ...meeting,
        bulletPoints: null,
        topics: null,
        date: meeting.date.toISOString(),
        createdAt: meeting.createdAt.toISOString(),
        updatedAt: meeting.updatedAt.toISOString(),
        workspaceId: meeting.workspaceId,
      },
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    res.status(500).json({ success: false, error: "Failed to create meeting" });
  }
});

// ---------- GET /api/meetings/:id ----------
legacyMeetingRoutes.get("/:id", async (req: Request, res: Response) => {
  try {
    const wid = await defaultWorkspace(req.user!.id);
    const meeting = await prisma.meeting.findFirst({
      where: {
        id: req.params.id,
        OR: [
          { workspaceId: wid },
          { sharedTo: { some: { workspaceId: wid } } },
        ],
      },
      include: { tasks: { orderBy: { createdAt: "desc" } } },
    });

    if (!meeting) {
      res.status(404).json({ success: false, error: "Meeting not found" });
      return;
    }

    res.json({
      success: true,
      data: {
        ...meeting,
        bulletPoints: meeting.bulletPoints ? JSON.parse(meeting.bulletPoints) : null,
        topics: meeting.topics ? JSON.parse(meeting.topics) : null,
        date: meeting.date.toISOString(),
        createdAt: meeting.createdAt.toISOString(),
        updatedAt: meeting.updatedAt.toISOString(),
        workspaceId: meeting.workspaceId,
      },
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    res.status(500).json({ success: false, error: "Failed to get meeting" });
  }
});

// ---------- PATCH /api/meetings/:id ----------
legacyMeetingRoutes.patch("/:id", async (req: Request, res: Response) => {
  try {
    const wid = await defaultWorkspace(req.user!.id);
    const meeting = await prisma.meeting.findFirst({
      where: { id: req.params.id, workspaceId: wid },
    });
    if (!meeting) {
      res.status(404).json({ success: false, error: "Meeting not found" });
      return;
    }

    const { title, duration } = req.body;
    const data: Record<string, unknown> = {};
    if (title !== undefined) {
      if (typeof title !== "string" || !title.trim()) {
        res.status(400).json({ success: false, error: "Invalid title" });
        return;
      }
      data.title = title.trim();
    }
    if (duration !== undefined) {
      if (typeof duration !== "number" || duration < 0) {
        res.status(400).json({ success: false, error: "Invalid duration" });
        return;
      }
      data.duration = Math.round(duration);
    }
    if (Object.keys(data).length === 0) {
      res.status(400).json({ success: false, error: "No valid fields to update" });
      return;
    }

    const updated = await prisma.meeting.update({
      where: { id: req.params.id },
      data,
    });
    res.json({
      success: true,
      data: {
        ...updated,
        date: updated.date.toISOString(),
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
        workspaceId: updated.workspaceId,
      },
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    res.status(500).json({ success: false, error: "Failed to update meeting" });
  }
});

// ---------- DELETE /api/meetings/:id ----------
legacyMeetingRoutes.delete("/:id", async (req: Request, res: Response) => {
  try {
    const wid = await defaultWorkspace(req.user!.id);
    const meeting = await prisma.meeting.findFirst({
      where: { id: req.params.id, workspaceId: wid },
    });
    if (!meeting) {
      res.status(404).json({ success: false, error: "Meeting not found" });
      return;
    }

    if (meeting.recordingUrl) {
      const storage = getStorageProvider();
      await storage.delete(meeting.recordingUrl);
    }
    await prisma.meeting.delete({ where: { id: req.params.id } });
    res.json({ success: true, data: { message: "Meeting deleted" } });
  } catch (err) {
    if (err instanceof AppError) throw err;
    res.status(500).json({ success: false, error: "Failed to delete meeting" });
  }
});

// ---------- POST /api/meetings/:id/audio ----------
legacyMeetingRoutes.post("/:id/audio", upload.single("audio"), async (req: Request, res: Response) => {
  try {
    const wid = await defaultWorkspace(req.user!.id);
    const meeting = await prisma.meeting.findFirst({
      where: { id: req.params.id, workspaceId: wid },
    });
    if (!meeting) {
      res.status(404).json({ success: false, error: "Meeting not found" });
      return;
    }
    if (!req.file) {
      res.status(400).json({ success: false, error: "No audio file provided" });
      return;
    }

    const tmpPath = req.file.path;
    const filename = req.file.filename;

    if (!fs.existsSync(tmpPath)) {
      res.status(500).json({ success: false, error: "Audio file was not saved to temp disk" });
      return;
    }
    const fileSize = fs.statSync(tmpPath).size;
    if (fileSize === 0) {
      fs.unlinkSync(tmpPath);
      res.status(400).json({ success: false, error: "Uploaded audio file is empty" });
      return;
    }

    const storage = getStorageProvider();
    let savedFilename = filename;
    let enhancedData: Buffer;
    try {
      const { normalizeAudio } = await import("../services/transcription");
      const normalizedPath = normalizeAudio(tmpPath);
      enhancedData = fs.readFileSync(normalizedPath);
      savedFilename = filename.replace(/\.[^.]+$/, ".wav");
      if (normalizedPath !== tmpPath && fs.existsSync(normalizedPath)) {
        try { fs.unlinkSync(normalizedPath); } catch { /* ignore */ }
      }
    } catch {
      enhancedData = fs.readFileSync(tmpPath);
    }
    await storage.save(savedFilename, enhancedData, getMimeType(savedFilename));
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }

    const updated = await prisma.meeting.update({
      where: { id: req.params.id },
      data: { recordingUrl: savedFilename, status: "uploading" },
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`✗ Audio upload failed for meeting ${req.params.id}:`, message);
    res.status(500).json({ success: false, error: `Failed to upload audio: ${message}` });
  }
});

// ---------- GET /api/meetings/:id/audio ----------
legacyMeetingRoutes.get("/:id/audio", async (req: Request, res: Response) => {
  try {
    const wid = await defaultWorkspace(req.user!.id);
    const meeting = await prisma.meeting.findFirst({
      where: {
        id: req.params.id,
        OR: [{ workspaceId: wid }, { sharedTo: { some: { workspaceId: wid } } }],
      },
    });
    if (!meeting || !meeting.recordingUrl) {
      res.status(404).json({ success: false, error: "Audio not found" });
      return;
    }
    const storage = getStorageProvider();
    const data = await storage.read(meeting.recordingUrl);
    if (!data) {
      res.status(404).json({ success: false, error: "Audio file not found" });
      return;
    }
    res.setHeader("Content-Type", getMimeType(meeting.recordingUrl));
    res.send(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`✗ Audio download failed for meeting ${req.params.id}:`, message);
    res.status(500).json({ success: false, error: `Failed to download audio: ${message}` });
  }
});

// ---------- POST /api/meetings/:id/process ----------
legacyMeetingRoutes.post("/:id/process", async (req: Request, res: Response) => {
  try {
    const wid = await defaultWorkspace(req.user!.id);
    const meeting = await prisma.meeting.findFirst({
      where: { id: req.params.id, workspaceId: wid },
    });
    if (!meeting) {
      res.status(404).json({ success: false, error: "Meeting not found" });
      return;
    }
    if (!meeting.recordingUrl) {
      res.status(400).json({ success: false, error: "No audio uploaded yet" });
      return;
    }

    const storage = getStorageProvider();
    const fileExists = await storage.exists(meeting.recordingUrl);
    if (!fileExists) {
      res.status(400).json({ success: false, error: `Audio file "${meeting.recordingUrl}" not found in storage. Please upload again.` });
      return;
    }
    if (["transcribing", "summarizing"].includes(meeting.status)) {
      res.status(202).json({ success: true, data: { message: "Already processing", meetingId: meeting.id, status: meeting.status } });
      return;
    }
    if (meeting.status === "error") {
      await prisma.meeting.update({ where: { id: meeting.id }, data: { error: null } });
    }

    const llmOverride: Partial<LlmOverride> = {};
    if (req.headers["x-llm-provider"]) llmOverride.provider = String(req.headers["x-llm-provider"]);
    if (req.headers["x-llm-key"]) llmOverride.apiKey = String(req.headers["x-llm-key"]);
    if (req.headers["x-llm-model"]) llmOverride.model = String(req.headers["x-llm-model"]);
    if (req.headers["x-llm-base-url"]) llmOverride.baseURL = String(req.headers["x-llm-base-url"]);

    (async () => {
      let audioTmpPath: string | null = null;
      try {
        await prisma.meeting.update({ where: { id: meeting.id }, data: { status: "transcribing" } });
        const m = await prisma.meeting.findUniqueOrThrow({ where: { id: meeting.id } });
        const audioData = await storage.read(m.recordingUrl!);
        if (!audioData) throw new Error(`Audio file "${m.recordingUrl}" not found`);
        audioTmpPath = path.resolve(config.audio.storagePath, `.process-${m.recordingUrl}`);
        fs.writeFileSync(audioTmpPath, audioData);
        const { transcribeAudio } = await import("../services/transcription");
        const transcript = await transcribeAudio(audioTmpPath);
        await prisma.meeting.update({ where: { id: meeting.id }, data: { transcript, status: "summarizing" } });
        const { summarizeMeeting } = await import("../services/summarizer");
        const summary = await summarizeMeeting(transcript, {
          meetingTitle: meeting.title,
          llmOverride: llmOverride.provider ? (llmOverride as LlmOverride) : undefined,
        });
        await prisma.meeting.update({
          where: { id: meeting.id },
          data: {
            summary: summary.summary,
            bulletPoints: JSON.stringify(summary.bulletPoints),
            topics: JSON.stringify(summary.marketingTopics),
            status: "complete",
          },
        });
        if (summary.tasks.length > 0) {
          await prisma.task.createMany({
            data: summary.tasks.map((t: any) => ({
              meetingId: meeting.id,
              description: t.description,
              assignee: t.assignee || null,
              priority: t.priority || null,
            })),
          });
        }
        console.log(`✓ Meeting ${meeting.id} processed successfully`);
      } catch (err: any) {
        console.error(`✗ Meeting ${meeting.id} processing failed:`, err.message);
        await prisma.meeting.update({ where: { id: meeting.id }, data: { status: "error", error: err.message } });
      } finally {
        if (audioTmpPath && fs.existsSync(audioTmpPath)) {
          try { fs.unlinkSync(audioTmpPath); } catch { /* ignore */ }
        }
      }
    })().catch((err) => console.error(`Processing failed for meeting ${meeting.id}:`, err));

    res.status(202).json({ success: true, data: { message: "Processing started", meetingId: meeting.id } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`✗ Failed to start processing for meeting ${req.params.id}:`, message);
    res.status(500).json({ success: false, error: `Failed to start processing: ${message}` });
  }
});

// ---------- GET /api/meetings/:id/transcript ----------
legacyMeetingRoutes.get("/:id/transcript", async (req: Request, res: Response) => {
  try {
    const wid = await defaultWorkspace(req.user!.id);
    const meeting = await prisma.meeting.findFirst({
      where: {
        id: req.params.id,
        OR: [{ workspaceId: wid }, { sharedTo: { some: { workspaceId: wid } } }],
      },
    });
    if (!meeting) { res.status(404).json({ success: false, error: "Meeting not found" }); return; }
    res.json({ success: true, data: { transcript: meeting.transcript, status: meeting.status } });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to get transcript" });
  }
});

// ---------- GET /api/meetings/:id/summary ----------
legacyMeetingRoutes.get("/:id/summary", async (req: Request, res: Response) => {
  try {
    const wid = await defaultWorkspace(req.user!.id);
    const meeting = await prisma.meeting.findFirst({
      where: {
        id: req.params.id,
        OR: [{ workspaceId: wid }, { sharedTo: { some: { workspaceId: wid } } }],
      },
    });
    if (!meeting) { res.status(404).json({ success: false, error: "Meeting not found" }); return; }
    res.json({
      success: true,
      data: {
        summary: meeting.summary,
        bulletPoints: meeting.bulletPoints ? JSON.parse(meeting.bulletPoints) : null,
        topics: meeting.topics ? JSON.parse(meeting.topics) : null,
        status: meeting.status,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to get summary" });
  }
});

// ---------- GET /api/meetings/:id/tasks ----------
legacyMeetingRoutes.get("/:id/tasks", async (req: Request, res: Response) => {
  try {
    const wid = await defaultWorkspace(req.user!.id);
    const meeting = await prisma.meeting.findFirst({
      where: {
        id: req.params.id,
        OR: [{ workspaceId: wid }, { sharedTo: { some: { workspaceId: wid } } }],
      },
    });
    if (!meeting) { res.status(404).json({ success: false, error: "Meeting not found" }); return; }
    const tasks = await prisma.task.findMany({
      where: { meetingId: meeting.id },
      orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
    });
    res.json({ success: true, data: tasks });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to get tasks" });
  }
});

// ---------- PATCH /api/tasks/:id ----------
legacyMeetingRoutes.patch("/tasks/:id", async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: { meeting: { include: { workspace: true } } },
    });
    if (!task) { res.status(404).json({ success: false, error: "Task not found" }); return; }

    // Verify user is a member of the meeting's workspace
    const membership = await prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId, workspaceId: task.meeting.workspaceId } },
    });
    if (!membership) {
      res.status(403).json({ success: false, error: "Access denied" });
      return;
    }

    const { status, assignee, priority } = req.body;
    const data: Record<string, unknown> = {};
    if (status !== undefined) data.status = status;
    if (assignee !== undefined) data.assignee = assignee;
    if (priority !== undefined) data.priority = priority;

    const updated = await prisma.task.update({
      where: { id: req.params.id },
      data,
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    if (err instanceof AppError) throw err;
    res.status(500).json({ success: false, error: "Failed to update task" });
  }
});
