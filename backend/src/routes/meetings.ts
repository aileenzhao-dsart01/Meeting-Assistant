import { Router, Request, Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { config } from "../config";
import { prisma } from "../db";
import { getStorageProvider } from "../services/storage";
import { LlmOverride } from "../services/summarizer";
import { requireWorkspaceAdmin } from "../middleware/workspace";
import { AppError, Errors } from "../utils/errors";
import { WorkspaceRole } from "../types";

export const meetingRoutes = Router();

// NOTE: Auth + workspace membership are applied at mount time in index.ts.
// req.workspace is available with { id, role }.

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

/** Resolve meeting + check access for the current user + workspace. */
async function resolveMeeting(
  meetingId: string,
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
) {
  const isOwnerAdmin = role === "owner" || role === "admin";
  const isViewer = role === "viewer";

  const meeting = await prisma.meeting.findFirst({
    where: {
      id: meetingId,
      workspaceId,
      ...(isViewer
        ? { OR: [{ createdBy: userId }, { shares: { some: { sharedWithUserId: userId } } }] }
        : {}),
    },
    include: { tasks: { orderBy: { createdAt: "desc" as const } } },
  });

  if (!meeting) throw Errors.notFound("Meeting not found");

  const isCreator = meeting.createdBy === userId;
  const canEdit = isOwnerAdmin || (role === "member" && isCreator);
  const access = canEdit ? ("own" as const) : ("shared" as const);

  return { meeting, access, canEdit, isCreator };
}

/** Check that the requester can edit this meeting. */
function assertCanEdit(access: "own" | "shared"): void {
  if (access !== "own") {
    throw Errors.insufficientPermissions(
      "You do not have permission to modify this meeting",
    );
  }
}

function formatMeeting(m: any, access: "own" | "shared") {
  return {
    id: m.id,
    title: m.title,
    date: m.date instanceof Date ? m.date.toISOString() : m.date,
    duration: m.duration,
    status: m.status,
    recordingUrl: m.recordingUrl,
    transcript: m.transcript,
    summary: m.summary,
    bulletPoints: m.bulletPoints ? JSON.parse(m.bulletPoints) : null,
    topics: m.topics ? JSON.parse(m.topics) : null,
    error: m.error,
    workspaceId: m.workspaceId,
    createdBy: m.createdBy,
    access,
    tasks:
      m.tasks?.map((t: any) => ({
        id: t.id,
        description: t.description,
        assignee: t.assignee,
        status: t.status,
        priority: t.priority,
      })) ?? [],
    createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt,
    updatedAt: m.updatedAt instanceof Date ? m.updatedAt.toISOString() : m.updatedAt,
  };
}

function formatMeetingListItem(m: any) {
  return {
    id: m.id,
    title: m.title,
    date: m.date instanceof Date ? m.date.toISOString() : m.date,
    duration: m.duration,
    status: m.status,
    taskCount: m._count?.tasks ?? 0,
    workspaceId: m.workspaceId,
    createdBy: m.createdBy,
    access: m._access || "own",
  };
}

// ---------- Multer ----------

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

// ════════════════════════════════════════════════════════════════════
// MEETING CRUD
// ════════════════════════════════════════════════════════════════════

// ---------- LIST meetings ----------
meetingRoutes.get("/", async (req: Request, res: Response) => {
  try {
    const { status, page = "1", limit = "20" } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);
    const wid = req.workspace!.id;
    const userId = req.user!.id;
    const role = req.workspace!.role;

    const whereStatus = status ? { status: status as string } : {};

    // Owner/admin/member: see all meetings in workspace
    // Viewer: only see shared meetings or ones they created
    const isOwnerAdmin = role === "owner" || role === "admin";
    const isViewer = role === "viewer";

    let where: any = { workspaceId: wid, ...whereStatus };

    if (isViewer) {
      where.OR = [
        { createdBy: userId },
        { shares: { some: { sharedWithUserId: userId } } },
      ];
    }

    const [meetings, total] = await Promise.all([
      prisma.meeting.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: "desc" as const },
        include: { _count: { select: { tasks: true } } },
      }),
      prisma.meeting.count({ where }),
    ]);

    // Determine access for each meeting
    const items = meetings.map((m) => {
      const isCreator = m.createdBy === userId;
      const canEdit = isOwnerAdmin || (role === "member" && isCreator);
      return { ...formatMeetingListItem(m), access: canEdit ? "own" : "shared" };
    });

    res.json({
      success: true,
      data: {
        meetings: items,
        total,
        page: parseInt(page as string),
        limit: take,
      },
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    console.error(" Failed to list meetings:", err);
    res.status(500).json({ error: "server_error", message: "Failed to list meetings" });
  }
});

// ---------- CREATE meeting ----------
meetingRoutes.post("/", async (req: Request, res: Response) => {
  try {
    // Only owner/admin/member can create — not viewer
    if (req.workspace!.role === "viewer") {
      res.status(403).json({ error: "insufficient_permissions", message: "Viewers cannot create meetings" });
      return;
    }

    const { title } = req.body;
    if (!title || typeof title !== "string") {
      res.status(400).json({ error: "validation_error", message: "Title is required" });
      return;
    }

    const meeting = await prisma.meeting.create({
      data: {
        title,
        workspaceId: req.workspace!.id,
        createdBy: req.user!.id,
        status: "pending",
      },
    });

    res.status(201).json({
      success: true,
      data: {
        ...meeting,
        access: "own",
        bulletPoints: null,
        topics: null,
        tasks: [],
        date: meeting.date.toISOString(),
        createdAt: meeting.createdAt.toISOString(),
        updatedAt: meeting.updatedAt.toISOString(),
      },
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    console.error(" Failed to create meeting:", err);
    res.status(500).json({ error: "server_error", message: "Failed to create meeting" });
  }
});

// ---------- GET meeting ----------
meetingRoutes.get("/:mid", async (req: Request, res: Response) => {
  try {
    const { meeting, access } = await resolveMeeting(
      String(req.params.mid),
      req.workspace!.id,
      req.user!.id,
      req.workspace!.role,
    );
    res.json({ success: true, data: formatMeeting(meeting, access) });
  } catch (err) {
    if (err instanceof AppError) throw err;
    console.error(" Failed to get meeting:", err);
    res.status(500).json({ error: "server_error", message: "Failed to get meeting" });
  }
});

// ---------- PATCH meeting ----------
meetingRoutes.patch("/:mid", async (req: Request, res: Response) => {
  try {
    const { meeting, access } = await resolveMeeting(
      String(req.params.mid),
      req.workspace!.id,
      req.user!.id,
      req.workspace!.role,
    );
    assertCanEdit(access);

    const { title, duration } = req.body;
    const data: Record<string, unknown> = {};

    if (title !== undefined) {
      if (typeof title !== "string" || !title.trim()) {
        res.status(400).json({ error: "validation_error", message: "Invalid title" });
        return;
      }
      data.title = title.trim();
    }
    if (duration !== undefined) {
      if (typeof duration !== "number" || duration < 0) {
        res.status(400).json({ error: "validation_error", message: "Invalid duration" });
        return;
      }
      data.duration = Math.round(duration);
    }
    if (Object.keys(data).length === 0) {
      res.status(400).json({ error: "validation_error", message: "No valid fields to update" });
      return;
    }

    const updated = await prisma.meeting.update({
      where: { id: String(req.params.mid) },
      data,
      include: { tasks: { orderBy: { createdAt: "desc" as const } } },
    });

    res.json({ success: true, data: formatMeeting(updated, "own") });
  } catch (err) {
    if (err instanceof AppError) throw err;
    console.error(" Failed to update meeting:", err);
    res.status(500).json({ error: "server_error", message: "Failed to update meeting" });
  }
});

// ---------- DELETE meeting ----------
meetingRoutes.delete("/:mid", async (req: Request, res: Response) => {
  try {
    const { meeting, access } = await resolveMeeting(
      String(req.params.mid),
      req.workspace!.id,
      req.user!.id,
      req.workspace!.role,
    );
    assertCanEdit(access);

    if (meeting.recordingUrl) {
      const storage = getStorageProvider();
      await storage.delete(meeting.recordingUrl);
    }

    await prisma.meeting.delete({ where: { id: String(req.params.mid) } });
    res.json({ success: true, data: { message: "Meeting deleted" } });
  } catch (err) {
    if (err instanceof AppError) throw err;
    console.error(" Failed to delete meeting:", err);
    res.status(500).json({ error: "server_error", message: "Failed to delete meeting" });
  }
});

// ════════════════════════════════════════════════════════════════════
// AUDIO
// ════════════════════════════════════════════════════════════════════

// ---------- UPLOAD audio ----------
meetingRoutes.post("/:mid/audio", upload.single("audio"), async (req: Request, res: Response) => {
  try {
    const { meeting, access } = await resolveMeeting(
      String(req.params.mid),
      req.workspace!.id,
      req.user!.id,
      req.workspace!.role,
    );
    assertCanEdit(access);

    if (!req.file) {
      res.status(400).json({ error: "validation_error", message: "No audio file provided" });
      return;
    }

    const tmpPath = req.file.path;
    const filename = req.file.filename;

    if (!fs.existsSync(tmpPath)) {
      res.status(500).json({ error: "server_error", message: "Audio file was not saved" });
      return;
    }
    const fileSize = fs.statSync(tmpPath).size;
    if (fileSize === 0) {
      fs.unlinkSync(tmpPath);
      res.status(400).json({ error: "validation_error", message: "Uploaded audio file is empty" });
      return;
    }

    const storage = getStorageProvider();
    let savedFilename = filename;
    let targetPath = tmpPath;
    try {
      const { normalizeAudio } = await import("../services/transcription");
      const normalizedPath = normalizeAudio(tmpPath);
      targetPath = normalizedPath;
      savedFilename = filename.replace(/\.[^.]+$/, ".wav");
    } catch {
      targetPath = tmpPath;
    }

    await storage.save(savedFilename, targetPath, getMimeType(savedFilename));

    // Clean up temp files
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    if (targetPath !== tmpPath) {
      try { fs.unlinkSync(targetPath); } catch { /* ignore */ }
    }

    const updated = await prisma.meeting.update({
      where: { id: String(req.params.mid) },
      data: { recordingUrl: savedFilename, status: "uploading" },
    });

    res.json({ success: true, data: { ...updated, access: "own" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(` Audio upload failed: ${message}`);
    res.status(500).json({ error: "server_error", message: `Failed to upload audio: ${message}` });
  }
});

// ---------- DOWNLOAD audio ----------
meetingRoutes.get("/:mid/audio", async (req: Request, res: Response) => {
  try {
    const { meeting } = await resolveMeeting(
      String(req.params.mid),
      req.workspace!.id,
      req.user!.id,
      req.workspace!.role,
    );

    if (!meeting.recordingUrl) {
      res.status(404).json({ error: "not_found", message: "Audio not found" });
      return;
    }

    const storage = getStorageProvider();
    const data = await storage.read(meeting.recordingUrl);
    if (!data) {
      res.status(404).json({ error: "not_found", message: "Audio file not found" });
      return;
    }

    res.setHeader("Content-Type", getMimeType(meeting.recordingUrl));
    res.send(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(` Audio download failed: ${message}`);
    res.status(500).json({ error: "server_error", message: "Failed to download audio" });
  }
});

// ════════════════════════════════════════════════════════════════════
// PROCESS (transcribe + summarize)
// ════════════════════════════════════════════════════════════════════

meetingRoutes.post("/:mid/process", async (req: Request, res: Response) => {
  try {
    const { meeting, access } = await resolveMeeting(
      String(req.params.mid),
      req.workspace!.id,
      req.user!.id,
      req.workspace!.role,
    );
    assertCanEdit(access);

    if (!meeting.recordingUrl) {
      res.status(400).json({ error: "validation_error", message: "No audio uploaded yet" });
      return;
    }

    const storage = getStorageProvider();
    const fileExists = await storage.exists(meeting.recordingUrl);
    if (!fileExists) {
      res.status(400).json({
        error: "validation_error",
        message: `Audio file "${meeting.recordingUrl}" not found in storage. Please upload again.`,
      });
      return;
    }

    if (["transcribing", "summarizing"].includes(meeting.status)) {
      res.status(202).json({
        success: true,
        data: { message: "Already processing", meetingId: meeting.id, status: meeting.status },
      });
      return;
    }

    if (meeting.status === "error") {
      await prisma.meeting.update({
        where: { id: meeting.id },
        data: { error: null },
      });
    }

    const llmOverride: Partial<LlmOverride> = {};
    if (req.headers["x-llm-provider"]) llmOverride.provider = String(req.headers["x-llm-provider"]);
    if (req.headers["x-llm-key"]) llmOverride.apiKey = String(req.headers["x-llm-key"]);
    if (req.headers["x-llm-model"]) llmOverride.model = String(req.headers["x-llm-model"]);
    if (req.headers["x-llm-base-url"]) llmOverride.baseURL = String(req.headers["x-llm-base-url"]);

    processMeeting(meeting.id, llmOverride).catch((err) =>
      console.error(`Processing failed for meeting ${meeting.id}:`, err)
    );

    res.status(202).json({
      success: true,
      data: { message: "Processing started", meetingId: meeting.id },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(` Failed to start processing: ${message}`);
    res.status(500).json({ error: "server_error", message: `Failed to start processing: ${message}` });
  }
});

// ════════════════════════════════════════════════════════════════════
// TRANSCRIPT / SUMMARY
// ════════════════════════════════════════════════════════════════════

meetingRoutes.get("/:mid/transcript", async (req: Request, res: Response) => {
  try {
    const { meeting } = await resolveMeeting(
      String(req.params.mid),
      req.workspace!.id,
      req.user!.id,
      req.workspace!.role,
    );
    res.json({ success: true, data: { transcript: meeting.transcript, status: meeting.status } });
  } catch (err) {
    if (err instanceof AppError) throw err;
    res.status(500).json({ error: "server_error", message: "Failed to get transcript" });
  }
});

meetingRoutes.get("/:mid/summary", async (req: Request, res: Response) => {
  try {
    const { meeting } = await resolveMeeting(
      String(req.params.mid),
      req.workspace!.id,
      req.user!.id,
      req.workspace!.role,
    );
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
    if (err instanceof AppError) throw err;
    res.status(500).json({ error: "server_error", message: "Failed to get summary" });
  }
});

// ════════════════════════════════════════════════════════════════════
// TASKS
// ════════════════════════════════════════════════════════════════════

meetingRoutes.get("/:mid/tasks", async (req: Request, res: Response) => {
  try {
    const { meeting } = await resolveMeeting(
      String(req.params.mid),
      req.workspace!.id,
      req.user!.id,
      req.workspace!.role,
    );
    const tasks = await prisma.task.findMany({
      where: { meetingId: meeting.id },
      orderBy: [{ priority: "asc" as const }, { createdAt: "desc" as const }],
    });
    res.json({ success: true, data: tasks });
  } catch (err) {
    if (err instanceof AppError) throw err;
    res.status(500).json({ error: "server_error", message: "Failed to get tasks" });
  }
});

meetingRoutes.patch("/:mid/tasks/:tid", async (req: Request, res: Response) => {
  try {
    const { access } = await resolveMeeting(
      String(req.params.mid),
      req.workspace!.id,
      req.user!.id,
      req.workspace!.role,
    );
    assertCanEdit(access);

    const { status, assignee, priority } = req.body;
    const data: Record<string, unknown> = {};
    if (status !== undefined) data.status = status;
    if (assignee !== undefined) data.assignee = assignee;
    if (priority !== undefined) data.priority = priority;

    if (Object.keys(data).length === 0) {
      res.status(400).json({ error: "validation_error", message: "No valid fields to update" });
      return;
    }

    const task = await prisma.task.findUnique({ where: { id: String(req.params.tid) } });
    if (!task || task.meetingId !== String(req.params.mid)) {
      res.status(404).json({ error: "not_found", message: "Task not found" });
      return;
    }

    const updated = await prisma.task.update({
      where: { id: String(req.params.tid) },
      data,
    });
    res.json({ success: true, data: updated });
  } catch (err) {
    if (err instanceof AppError) throw err;
    console.error(" Failed to update task:", err);
    res.status(500).json({ error: "server_error", message: "Failed to update task" });
  }
});

// ════════════════════════════════════════════════════════════════════
// MEETING SHARES (user-level sharing)
// ════════════════════════════════════════════════════════════════════

// ---------- GET shared-with ----------
meetingRoutes.get("/:mid/shared-with", async (req: Request, res: Response) => {
  try {
    const { meeting, access } = await resolveMeeting(
      String(req.params.mid),
      req.workspace!.id,
      req.user!.id,
      req.workspace!.role,
    );
    assertCanEdit(access);

    const shares = await prisma.meetingShare.findMany({
      where: { meetingId: meeting.id },
      orderBy: { sharedAt: "desc" as const },
    });

    res.json({
      success: true,
      data: shares.map((s) => ({
        userId: s.sharedWithUserId,
        sharedByUserId: s.sharedByUserId,
        sharedAt: s.sharedAt.toISOString(),
      })),
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    res.status(500).json({ error: "server_error", message: "Failed to get sharing info" });
  }
});

// ---------- POST share (share with a user) ----------
meetingRoutes.post("/:mid/share", async (req: Request, res: Response) => {
  try {
    // Only owner/admin can share
    if (req.workspace!.role !== "owner" && req.workspace!.role !== "admin") {
      res.status(403).json({ error: "insufficient_permissions", message: "Only admins can share meetings" });
      return;
    }

    const { meeting, access } = await resolveMeeting(
      String(req.params.mid),
      req.workspace!.id,
      req.user!.id,
      req.workspace!.role,
    );
    assertCanEdit(access);

    const { userId } = req.body;
    if (!userId || typeof userId !== "string") {
      res.status(400).json({ error: "validation_error", message: "userId is required (Supabase UUID)" });
      return;
    }

    const existing = await prisma.meetingShare.findUnique({
      where: { meetingId_sharedWithUserId: { meetingId: meeting.id, sharedWithUserId: userId } },
    });
    if (existing) {
      res.status(409).json({ error: "conflict", message: "Meeting is already shared with this user" });
      return;
    }

    const share = await prisma.meetingShare.create({
      data: {
        meetingId: meeting.id,
        sharedWithUserId: userId,
        sharedByUserId: req.user!.id,
      },
    });

    res.status(201).json({
      success: true,
      data: {
        userId: share.sharedWithUserId,
        sharedByUserId: share.sharedByUserId,
        sharedAt: share.sharedAt.toISOString(),
      },
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    console.error(" Failed to share meeting:", err);
    res.status(500).json({ error: "server_error", message: "Failed to share meeting" });
  }
});

// ---------- DELETE share (unshare with a user) ----------
meetingRoutes.delete("/:mid/share/:userId", async (req: Request, res: Response) => {
  try {
    if (req.workspace!.role !== "owner" && req.workspace!.role !== "admin") {
      res.status(403).json({ error: "insufficient_permissions", message: "Only admins can unshare meetings" });
      return;
    }

    const { meeting, access } = await resolveMeeting(
      String(req.params.mid),
      req.workspace!.id,
      req.user!.id,
      req.workspace!.role,
    );
    assertCanEdit(access);

    const existing = await prisma.meetingShare.findUnique({
      where: { meetingId_sharedWithUserId: { meetingId: meeting.id, sharedWithUserId: String(req.params.userId) } },
    });
    if (!existing) {
      res.status(404).json({ error: "not_found", message: "Share not found" });
      return;
    }

    await prisma.meetingShare.delete({
      where: { meetingId_sharedWithUserId: { meetingId: meeting.id, sharedWithUserId: String(req.params.userId) } },
    });

    res.json({ success: true, data: { message: "Meeting unshared" } });
  } catch (err) {
    if (err instanceof AppError) throw err;
    console.error(" Failed to unshare meeting:", err);
    res.status(500).json({ error: "server_error", message: "Failed to unshare meeting" });
  }
});

// ════════════════════════════════════════════════════════════════════
// ASYNC PROCESSING PIPELINE
// ════════════════════════════════════════════════════════════════════

async function processMeeting(
  meetingId: string,
  llmOverride?: { provider?: string; apiKey?: string; model?: string; baseURL?: string }
) {
  let audioTmpPath: string | null = null;

  try {
    await prisma.meeting.update({
      where: { id: meetingId },
      data: { status: "transcribing" },
    });

    const meeting = await prisma.meeting.findUniqueOrThrow({
      where: { id: meetingId },
    });

    const storage = getStorageProvider();
    const audioData = await storage.read(meeting.recordingUrl!);
    if (!audioData) throw new Error(`Audio file "${meeting.recordingUrl}" not found in storage`);

    audioTmpPath = path.resolve(config.audio.storagePath, `.process-${meeting.recordingUrl}`);
    fs.writeFileSync(audioTmpPath, audioData);

    const { transcribeAudio } = await import("../services/transcription");
    const transcript = await transcribeAudio(audioTmpPath);

    await prisma.meeting.update({
      where: { id: meetingId },
      data: { transcript, status: "summarizing" },
    });

    const { summarizeMeeting } = await import("../services/summarizer");
    const summary = await summarizeMeeting(transcript, {
      meetingTitle: meeting.title,
      llmOverride: llmOverride?.provider ? (llmOverride as LlmOverride) : undefined,
    });

    await prisma.meeting.update({
      where: { id: meetingId },
      data: {
        summary: summary.summary,
        bulletPoints: JSON.stringify(summary.bulletPoints),
        topics: JSON.stringify(summary.marketingTopics),
        status: "complete",
      },
    });

    if (summary.tasks.length > 0) {
      await prisma.task.createMany({
        data: summary.tasks.map((t: { description: string; assignee?: string; priority?: string }) => ({
          meetingId,
          description: t.description,
          assignee: t.assignee || null,
          priority: t.priority || null,
        })),
      });
    }

    console.log(`Meeting ${meetingId} processed successfully`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`Meeting ${meetingId} processing failed:`, message);
    await prisma.meeting.update({
      where: { id: meetingId },
      data: { status: "error", error: message },
    });
  } finally {
    if (audioTmpPath && fs.existsSync(audioTmpPath)) {
      try { fs.unlinkSync(audioTmpPath); } catch { /* ignore */ }
    }
  }
}
