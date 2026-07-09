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

export const meetingRoutes = Router();

// NOTE: Auth + workspace membership are applied at mount time in index.ts.
// Individual sharing routes that need admin role use requireWorkspaceAdmin explicitly.

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

/** Check whether the request's workspace owns the meeting (full access)
 *  vs only has shared access (read-only). Throws if no access at all. */
async function resolveMeetingAccess(
  meetingId: string,
  workspaceId: string,
): Promise<{ meeting: any; access: "own" | "shared" }> {
  const meeting = await prisma.meeting.findFirst({
    where: {
      id: meetingId,
      OR: [
        { workspaceId },                              // owned
        { sharedTo: { some: { workspaceId } } },      // shared with us
      ],
    },
    include: { tasks: { orderBy: { createdAt: "desc" as const } } },
  });

  if (!meeting) throw Errors.notFound("Meeting not found");

  const access: "own" | "shared" =
    meeting.workspaceId === workspaceId ? "own" : "shared";

  return { meeting, access };
}

/** Assert the requester owns (not merely has shared access to) the meeting. */
function assertOwnAccess(access: "own" | "shared"): void {
  if (access !== "own") {
    throw Errors.forbidden("Cannot modify a meeting shared with this workspace");
  }
}

function formatMeeting(m: any, meetingAccess: "own" | "shared") {
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
    access: meetingAccess,
    tasks: m.tasks?.map((t: any) => ({
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

// ---------- LIST meetings (owned + shared) ----------
meetingRoutes.get("/", async (req: Request, res: Response) => {
  try {
    const { status, page = "1", limit = "20" } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);
    const wid = req.workspace!.id;

    // Fetch owned meetings + IDs of meetings shared with this workspace
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
        orderBy: { createdAt: "desc" as const },
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
        meetings: meetings.map(formatMeetingListItem),
        total,
        page: parseInt(page as string),
        limit: take,
      },
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    console.error("✗ Failed to list meetings:", err);
    res.status(500).json({ success: false, error: "Failed to list meetings" });
  }
});

// ---------- CREATE meeting ----------
meetingRoutes.post("/", async (req: Request, res: Response) => {
  try {
    const { title } = req.body;
    if (!title || typeof title !== "string") {
      res.status(400).json({ success: false, error: "Title is required" });
      return;
    }

    const meeting = await prisma.meeting.create({
      data: {
        title,
        workspaceId: req.workspace!.id,
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
    console.error("✗ Failed to create meeting:", err);
    res.status(500).json({ success: false, error: "Failed to create meeting" });
  }
});

// ---------- GET meeting ----------
meetingRoutes.get("/:mid", async (req: Request, res: Response) => {
  try {
    const { meeting, access } = await resolveMeetingAccess(
      req.params.mid,
      req.workspace!.id,
    );
    res.json({ success: true, data: formatMeeting(meeting, access) });
  } catch (err) {
    if (err instanceof AppError) throw err;
    console.error("✗ Failed to get meeting:", err);
    res.status(500).json({ success: false, error: "Failed to get meeting" });
  }
});

// ---------- PATCH meeting ----------
meetingRoutes.patch("/:mid", async (req: Request, res: Response) => {
  try {
    const { meeting, access } = await resolveMeetingAccess(
      req.params.mid,
      req.workspace!.id,
    );
    assertOwnAccess(access);

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
      where: { id: req.params.mid },
      data,
      include: { tasks: { orderBy: { createdAt: "desc" as const } } },
    });

    res.json({ success: true, data: formatMeeting(updated, "own") });
  } catch (err) {
    if (err instanceof AppError) throw err;
    console.error("✗ Failed to update meeting:", err);
    res.status(500).json({ success: false, error: "Failed to update meeting" });
  }
});

// ---------- DELETE meeting ----------
meetingRoutes.delete("/:mid", async (req: Request, res: Response) => {
  try {
    const { meeting, access } = await resolveMeetingAccess(
      req.params.mid,
      req.workspace!.id,
    );
    assertOwnAccess(access);

    if (meeting.recordingUrl) {
      const storage = getStorageProvider();
      await storage.delete(meeting.recordingUrl);
    }

    await prisma.meeting.delete({ where: { id: req.params.mid } });
    res.json({ success: true, data: { message: "Meeting deleted" } });
  } catch (err) {
    if (err instanceof AppError) throw err;
    console.error("✗ Failed to delete meeting:", err);
    res.status(500).json({ success: false, error: "Failed to delete meeting" });
  }
});

// ════════════════════════════════════════════════════════════════════
// AUDIO
// ════════════════════════════════════════════════════════════════════

// ---------- UPLOAD audio ----------
meetingRoutes.post(
  "/:mid/audio",
  upload.single("audio"),
  async (req: Request, res: Response) => {
    try {
      const { meeting, access } = await resolveMeetingAccess(
        req.params.mid,
        req.workspace!.id,
      );
      assertOwnAccess(access);

      if (!req.file) {
        res.status(400).json({ success: false, error: "No audio file provided" });
        return;
      }

      const tmpPath = req.file.path;
      const filename = req.file.filename;

      if (!fs.existsSync(tmpPath)) {
        res.status(500).json({ success: false, error: "Audio file was not saved" });
        return;
      }

      const fileSize = fs.statSync(tmpPath).size;
      if (fileSize === 0) {
        fs.unlinkSync(tmpPath);
        res.status(400).json({ success: false, error: "Uploaded audio file is empty" });
        return;
      }

      const storage = getStorageProvider();
      const mimeType = getMimeType(filename);

      // Enhance audio before storing
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

      const savedMimeType = getMimeType(savedFilename);
      await storage.save(savedFilename, enhancedData, savedMimeType);

      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }

      const updated = await prisma.meeting.update({
        where: { id: req.params.mid },
        data: { recordingUrl: savedFilename, status: "uploading" },
      });

      res.json({ success: true, data: { ...updated, access: "own" } });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`✗ Audio upload failed for meeting ${req.params.mid}:`, message);
      res.status(500).json({ success: false, error: `Failed to upload audio: ${message}` });
    }
  },
);

// ---------- DOWNLOAD audio ----------
meetingRoutes.get("/:mid/audio", async (req: Request, res: Response) => {
  try {
    const { meeting, access } = await resolveMeetingAccess(
      req.params.mid,
      req.workspace!.id,
    );

    if (!meeting.recordingUrl) {
      res.status(404).json({ success: false, error: "Audio not found" });
      return;
    }

    const storage = getStorageProvider();
    const data = await storage.read(meeting.recordingUrl);
    if (!data) {
      res.status(404).json({ success: false, error: "Audio file not found" });
      return;
    }

    const mimeType = getMimeType(meeting.recordingUrl);
    res.setHeader("Content-Type", mimeType);
    res.send(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`✗ Audio download failed for meeting ${req.params.mid}:`, message);
    res.status(500).json({ success: false, error: `Failed to download audio: ${message}` });
  }
});

// ════════════════════════════════════════════════════════════════════
// PROCESS (transcribe + summarize)
// ════════════════════════════════════════════════════════════════════

// ---------- POST process ----------
meetingRoutes.post("/:mid/process", async (req: Request, res: Response) => {
  try {
    const { meeting, access } = await resolveMeetingAccess(
      req.params.mid,
      req.workspace!.id,
    );
    assertOwnAccess(access);

    if (!meeting.recordingUrl) {
      res.status(400).json({ success: false, error: "No audio uploaded yet" });
      return;
    }

    // Verify audio file exists
    const storage = getStorageProvider();
    const fileExists = await storage.exists(meeting.recordingUrl);
    if (!fileExists) {
      res.status(400).json({
        success: false,
        error: `Audio file "${meeting.recordingUrl}" not found in storage. Please upload again.`,
      });
      return;
    }

    // Idempotency
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

    // Capture optional LLM override headers
    const llmOverride: Partial<LlmOverride> = {};
    if (req.headers["x-llm-provider"]) llmOverride.provider = String(req.headers["x-llm-provider"]);
    if (req.headers["x-llm-key"]) llmOverride.apiKey = String(req.headers["x-llm-key"]);
    if (req.headers["x-llm-model"]) llmOverride.model = String(req.headers["x-llm-model"]);
    if (req.headers["x-llm-base-url"]) llmOverride.baseURL = String(req.headers["x-llm-base-url"]);

    // Kick off async processing
    processMeeting(meeting.id, llmOverride).catch((err) =>
      console.error(`Processing failed for meeting ${meeting.id}:`, err)
    );

    res.status(202).json({
      success: true,
      data: { message: "Processing started", meetingId: meeting.id },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`✗ Failed to start processing for meeting ${req.params.mid}:`, message);
    res.status(500).json({ success: false, error: `Failed to start processing: ${message}` });
  }
});

// ════════════════════════════════════════════════════════════════════
// TRANSCRIPT / SUMMARY (read-only for shared)
// ════════════════════════════════════════════════════════════════════

// ---------- GET transcript ----------
meetingRoutes.get("/:mid/transcript", async (req: Request, res: Response) => {
  try {
    const { meeting } = await resolveMeetingAccess(req.params.mid, req.workspace!.id);
    res.json({
      success: true,
      data: { transcript: meeting.transcript, status: meeting.status },
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    res.status(500).json({ success: false, error: "Failed to get transcript" });
  }
});

// ---------- GET summary ----------
meetingRoutes.get("/:mid/summary", async (req: Request, res: Response) => {
  try {
    const { meeting } = await resolveMeetingAccess(req.params.mid, req.workspace!.id);
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
    res.status(500).json({ success: false, error: "Failed to get summary" });
  }
});

// ════════════════════════════════════════════════════════════════════
// TASKS
// ════════════════════════════════════════════════════════════════════

// ---------- LIST tasks ----------
meetingRoutes.get("/:mid/tasks", async (req: Request, res: Response) => {
  try {
    const { meeting } = await resolveMeetingAccess(req.params.mid, req.workspace!.id);
    const tasks = await prisma.task.findMany({
      where: { meetingId: meeting.id },
      orderBy: [{ priority: "asc" as const }, { createdAt: "desc" as const }],
    });
    res.json({ success: true, data: tasks });
  } catch (err) {
    if (err instanceof AppError) throw err;
    res.status(500).json({ success: false, error: "Failed to get tasks" });
  }
});

// ---------- PATCH task ----------
meetingRoutes.patch("/:mid/tasks/:tid", async (req: Request, res: Response) => {
  try {
    // Verify meeting access (own required for task mutation)
    const { access } = await resolveMeetingAccess(req.params.mid, req.workspace!.id);
    assertOwnAccess(access);

    const { status, assignee, priority } = req.body;
    const data: Record<string, unknown> = {};
    if (status !== undefined) data.status = status;
    if (assignee !== undefined) data.assignee = assignee;
    if (priority !== undefined) data.priority = priority;

    if (Object.keys(data).length === 0) {
      res.status(400).json({ success: false, error: "No valid fields to update" });
      return;
    }

    const task = await prisma.task.findUnique({ where: { id: req.params.tid } });
    if (!task || task.meetingId !== req.params.mid) {
      res.status(404).json({ success: false, error: "Task not found" });
      return;
    }

    const updated = await prisma.task.update({
      where: { id: req.params.tid },
      data,
    });

    res.json({ success: true, data: updated });
  } catch (err) {
    if (err instanceof AppError) throw err;
    console.error("✗ Failed to update task:", err);
    res.status(500).json({ success: false, error: "Failed to update task" });
  }
});

// ════════════════════════════════════════════════════════════════════
// SHARING
// ════════════════════════════════════════════════════════════════════

// ---------- GET shared-with (list workspaces this meeting is shared with) ----------
meetingRoutes.get("/:mid/shared-with", async (req: Request, res: Response) => {
  try {
    const { meeting, access } = await resolveMeetingAccess(req.params.mid, req.workspace!.id);
    assertOwnAccess(access);

    const shared = await prisma.sharedMeeting.findMany({
      where: { meetingId: meeting.id },
      include: {
        workspace: { select: { id: true, name: true, slug: true } },
      },
    });

    res.json({
      success: true,
      data: shared.map((s) => ({
        workspaceId: s.workspace.id,
        workspaceName: s.workspace.name,
        workspaceSlug: s.workspace.slug,
        sharedAt: s.sharedAt.toISOString(),
      })),
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    res.status(500).json({ success: false, error: "Failed to get sharing info" });
  }
});

// ---------- POST share (share meeting with another workspace) ----------
meetingRoutes.post(
  "/:mid/share",
  requireWorkspaceAdmin,    // re-assert admin on the current workspace
  async (req: Request, res: Response) => {
    try {
      const { meeting, access } = await resolveMeetingAccess(req.params.mid, req.workspace!.id);
      assertOwnAccess(access);

      const { targetWorkspaceId } = req.body;
      if (!targetWorkspaceId || typeof targetWorkspaceId !== "string") {
        res.status(400).json({ success: false, error: "targetWorkspaceId is required" });
        return;
      }

      // Verify the target workspace exists
      const targetWorkspace = await prisma.workspace.findUnique({
        where: { id: targetWorkspaceId },
      });
      if (!targetWorkspace) {
        res.status(404).json({ success: false, error: "Target workspace not found" });
        return;
      }

      // Don't share with self
      if (targetWorkspaceId === req.workspace!.id) {
        res.status(400).json({ success: false, error: "Cannot share a meeting with its own workspace" });
        return;
      }

      // Check if already shared
      const existing = await prisma.sharedMeeting.findUnique({
        where: { meetingId_workspaceId: { meetingId: meeting.id, workspaceId: targetWorkspaceId } },
      });
      if (existing) {
        res.status(409).json({ success: false, error: "Meeting is already shared with this workspace" });
        return;
      }

      const shared = await prisma.sharedMeeting.create({
        data: {
          meetingId: meeting.id,
          workspaceId: targetWorkspaceId,
          sharedByUserId: req.user!.id,
        },
      });

      res.status(201).json({
        success: true,
        data: {
          meetingId: shared.meetingId,
          workspaceId: shared.workspaceId,
          sharedAt: shared.sharedAt.toISOString(),
        },
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      console.error("✗ Failed to share meeting:", err);
      res.status(500).json({ success: false, error: "Failed to share meeting" });
    }
  },
);

// ---------- DELETE share (unshare) ----------
meetingRoutes.delete(
  "/:mid/share",
  requireWorkspaceAdmin,
  async (req: Request, res: Response) => {
    try {
      const { meeting, access } = await resolveMeetingAccess(req.params.mid, req.workspace!.id);
      assertOwnAccess(access);

      const targetWorkspaceId = req.query.targetWorkspaceId as string;
      if (!targetWorkspaceId) {
        res.status(400).json({ success: false, error: "targetWorkspaceId query parameter is required" });
        return;
      }

      const existing = await prisma.sharedMeeting.findUnique({
        where: { meetingId_workspaceId: { meetingId: meeting.id, workspaceId: targetWorkspaceId } },
      });
      if (!existing) {
        res.status(404).json({ success: false, error: "Meeting is not shared with this workspace" });
        return;
      }

      await prisma.sharedMeeting.delete({
        where: { meetingId_workspaceId: { meetingId: meeting.id, workspaceId: targetWorkspaceId } },
      });

      res.json({ success: true, data: { message: "Meeting unshared" } });
    } catch (err) {
      if (err instanceof AppError) throw err;
      console.error("✗ Failed to unshare meeting:", err);
      res.status(500).json({ success: false, error: "Failed to unshare meeting" });
    }
  },
);

// ════════════════════════════════════════════════════════════════════
// ASYNC PROCESSING PIPELINE (unchanged from original)
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
    if (!audioData) {
      throw new Error(`Audio file "${meeting.recordingUrl}" not found in storage`);
    }

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

    console.log(`✓ Meeting ${meetingId} processed successfully`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`✗ Meeting ${meetingId} processing failed:`, message);
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
