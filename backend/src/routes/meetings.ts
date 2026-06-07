import { Router, Request, Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { config } from "../config";
import { prisma } from "../db";
import { getStorageProvider } from "../services/storage";
import { LlmOverride } from "../services/summarizer";

export const meetingRoutes = Router();

// Multer setup for audio uploads (temporary local storage)
const tmpStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    // Use OS temp dir for multer — storage provider handles persistence
    const tmpDir = path.resolve(config.audio.storagePath, ".upload-tmp");
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    cb(null, tmpDir);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${uniqueSuffix}${path.extname(file.originalname)}`);
  },
});
const upload = multer({
  storage: tmpStorage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max
});

// MIME types map for audio content
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

// ---------- LIST meetings ----------
meetingRoutes.get("/", async (req: Request, res: Response) => {
  try {
    const { status, page = "1", limit = "20" } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = parseInt(limit as string);

    const where = status ? { status: status as string } : {};

    const [meetings, total] = await Promise.all([
      prisma.meeting.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: "desc" },
        include: { _count: { select: { tasks: true } } },
      }),
      prisma.meeting.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        meetings: meetings.map((m: { id: string; title: string; date: Date; duration: number | null; status: string; _count: { tasks: number } }) => ({
          id: m.id,
          title: m.title,
          date: m.date.toISOString(),
          duration: m.duration,
          status: m.status,
          taskCount: m._count.tasks,
        })),
        total,
        page: parseInt(page as string),
        limit: take,
      },
    });
  } catch (err) {
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

    const meeting = await prisma.meeting.create({ data: { title } });
    res.status(201).json({
      success: true,
      data: {
        ...meeting,
        date: meeting.date.toISOString(),
        createdAt: meeting.createdAt.toISOString(),
        updatedAt: meeting.updatedAt.toISOString(),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to create meeting" });
  }
});

// ---------- GET meeting ----------
meetingRoutes.get("/:id", async (req: Request, res: Response) => {
  try {
    const meeting = await prisma.meeting.findUnique({
      where: { id: String(req.params.id) },
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
        bulletPoints: meeting.bulletPoints
          ? JSON.parse(meeting.bulletPoints)
          : null,
        topics: meeting.topics ? JSON.parse(meeting.topics) : null,
        date: meeting.date.toISOString(),
        createdAt: meeting.createdAt.toISOString(),
        updatedAt: meeting.updatedAt.toISOString(),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to get meeting" });
  }
});

// ---------- UPDATE meeting ----------
meetingRoutes.patch("/:id", async (req: Request, res: Response) => {
  try {
    const { title, duration } = req.body;

    // Allow updating fields individually — don't require title
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
      res.status(400).json({ success: false, error: "No valid fields to update (title or duration)" });
      return;
    }

    const meeting = await prisma.meeting.findUnique({
      where: { id: String(req.params.id) },
    });
    if (!meeting) {
      res.status(404).json({ success: false, error: "Meeting not found" });
      return;
    }

    const updated = await prisma.meeting.update({
      where: { id: String(req.params.id) },
      data,
    });

    res.json({
      success: true,
      data: {
        ...updated,
        date: updated.date.toISOString(),
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to rename meeting" });
  }
});

// ---------- DELETE meeting ----------
meetingRoutes.delete("/:id", async (req: Request, res: Response) => {
  try {
    const meeting = await prisma.meeting.findUnique({
      where: { id: String(req.params.id) },
    });
    if (!meeting) {
      res.status(404).json({ success: false, error: "Meeting not found" });
      return;
    }

    // Delete audio from storage provider
    if (meeting.recordingUrl) {
      const storage = getStorageProvider();
      await storage.delete(meeting.recordingUrl);
    }

    await prisma.meeting.delete({ where: { id: String(req.params.id) } });
    res.json({ success: true, data: { message: "Meeting deleted" } });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to delete meeting" });
  }
});

// ---------- UPLOAD audio ----------
meetingRoutes.post(
  "/:id/audio",
  upload.single("audio"),
  async (req: Request, res: Response) => {
    try {
      const meeting = await prisma.meeting.findUnique({
        where: { id: String(req.params.id) },
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

      // Check the temp file exists and has content
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

      // Save to the configured storage provider (local disk or Supabase)
      const storage = getStorageProvider();
      const mimeType = getMimeType(filename);
      const data = fs.readFileSync(tmpPath);
      await storage.save(filename, data, mimeType);

      // Clean up temp file
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }

      const updated = await prisma.meeting.update({
        where: { id: String(req.params.id) },
        data: {
          recordingUrl: filename,
          status: "uploading",
        },
      });

      res.json({ success: true, data: updated });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`✗ Audio upload failed for meeting ${String(req.params.id)}:`, message);
      res.status(500).json({ success: false, error: `Failed to upload audio: ${message}` });
    }
  }
);

// ---------- DOWNLOAD audio ----------
meetingRoutes.get("/:id/audio", async (req: Request, res: Response) => {
  try {
    const meeting = await prisma.meeting.findUnique({
      where: { id: String(req.params.id) },
    });
    if (!meeting || !meeting.recordingUrl) {
      res.status(404).json({ success: false, error: "Audio not found" });
      return;
    }

    const storage = getStorageProvider();

    // Check existence
    if (!(await storage.exists(meeting.recordingUrl))) {
      res.status(404).json({ success: false, error: "Audio file not found" });
      return;
    }

    // Try public URL first (for Supabase — direct browser streaming)
    const publicUrl = storage.getPublicUrl(meeting.recordingUrl);
    if (publicUrl) {
      // Supabase bucket is public — redirect to the CDN URL for efficient streaming
      // The frontend browser will fetch directly from Supabase CDN
      const mimeType = getMimeType(meeting.recordingUrl);
      res.setHeader("Content-Type", mimeType);
      res.redirect(publicUrl);
      return;
    }

    // Local storage fallback: stream the file
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
    console.error(`✗ Audio download failed for meeting ${String(req.params.id)}:`, message);
    res.status(500).json({ success: false, error: `Failed to download audio: ${message}` });
  }
});

// ---------- PROCESS (transcribe + summarize) ----------
meetingRoutes.post("/:id/process", async (req: Request, res: Response) => {
  try {
    const meeting = await prisma.meeting.findUnique({
      where: { id: String(req.params.id) },
    });
    if (!meeting) {
      res.status(404).json({ success: false, error: "Meeting not found" });
      return;
    }
    if (!meeting.recordingUrl) {
      res.status(400).json({ success: false, error: "No audio uploaded yet" });
      return;
    }

    // Verify the audio file exists in storage
    const storage = getStorageProvider();
    console.log(`  → Checking storage for: ${meeting.recordingUrl} (provider: ${storage.name})`);
    const fileExists = await storage.exists(meeting.recordingUrl);
    if (!fileExists) {
      res.status(400).json({
        success: false,
        error: `Audio file "${meeting.recordingUrl}" not found in storage. The upload may have failed. Please upload again.`,
      });
      return;
    }

    // Idempotency: don't start a second job if already processing
    if (["transcribing", "summarizing"].includes(meeting.status)) {
      res.status(202).json({
        success: true,
        data: { message: "Already processing", meetingId: meeting.id, status: meeting.status },
      });
      return;
    }

    // Reset error state if re-processing
    if (meeting.status === "error") {
      await prisma.meeting.update({
        where: { id: meeting.id },
        data: { error: null },
      });
    }

    // Capture optional LLM override headers
    const llmOverride: Partial<LlmOverride> = {};
    if (req.headers["x-llm-provider"]) {
      llmOverride.provider = String(req.headers["x-llm-provider"]);
    }
    if (req.headers["x-llm-key"]) {
      llmOverride.apiKey = String(req.headers["x-llm-key"]);
    }
    if (req.headers["x-llm-model"]) {
      llmOverride.model = String(req.headers["x-llm-model"]);
    }
    if (req.headers["x-llm-base-url"]) {
      llmOverride.baseURL = String(req.headers["x-llm-base-url"]);
    }

    // Log which LLM is being used
    if (llmOverride.provider && llmOverride.model) {
      console.log(`  → LLM override from headers: ${llmOverride.provider}/${llmOverride.model}`);
    }

    // Kick off async processing (non-blocking)
    processMeeting(meeting.id, llmOverride).catch((err) =>
      console.error(`Processing failed for meeting ${meeting.id}:`, err)
    );

    res.status(202).json({
      success: true,
      data: { message: "Processing started", meetingId: meeting.id },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`✗ Failed to start processing for meeting ${String(req.params.id)}:`, message);
    res.status(500).json({ success: false, error: `Failed to start processing: ${message}` });
  }
});

// ---------- Async processing pipeline ----------
async function processMeeting(
  meetingId: string,
  llmOverride?: { provider?: string; apiKey?: string; model?: string; baseURL?: string }
) {
  let audioTmpPath: string | null = null;

  try {
    // 1. Transcribe
    await prisma.meeting.update({
      where: { id: meetingId },
      data: { status: "transcribing" },
    });

    const meeting = await prisma.meeting.findUniqueOrThrow({
      where: { id: meetingId },
    });

    // Download audio from storage to a temp file for processing
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

    // 2. Summarize
    const { summarizeMeeting } = await import("../services/summarizer");
    const summary = await summarizeMeeting(transcript, {
      meetingTitle: meeting.title,
      llmOverride: llmOverride?.provider ? (llmOverride as LlmOverride) : undefined,
    });

    // Save summary + tasks
    await prisma.meeting.update({
      where: { id: meetingId },
      data: {
        summary: summary.summary,
        bulletPoints: JSON.stringify(summary.bulletPoints),
        topics: JSON.stringify(summary.marketingTopics),
        status: "complete",
      },
    });

    // Create tasks
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
    // Clean up temp processing file
    if (audioTmpPath && fs.existsSync(audioTmpPath)) {
      try { fs.unlinkSync(audioTmpPath); } catch { /* ignore */ }
    }
  }
}
