import { Router, Request, Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { config } from "../config";
import { prisma } from "../db";

export const meetingRoutes = Router();

// Ensure audio storage exists
if (!fs.existsSync(config.audio.storagePath)) {
  fs.mkdirSync(config.audio.storagePath, { recursive: true });
}

// Multer setup for audio uploads
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.audio.storagePath),
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${uniqueSuffix}${path.extname(file.originalname)}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max
});

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
    res.status(201).json({ success: true, data: meeting });
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

    // Delete audio file if exists
    if (meeting.recordingUrl) {
      const audioPath = path.resolve(config.audio.storagePath, meeting.recordingUrl);
      if (fs.existsSync(audioPath)) {
        fs.unlinkSync(audioPath);
      }
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

      const updated = await prisma.meeting.update({
        where: { id: String(req.params.id) },
        data: {
          recordingUrl: req.file.filename,
          status: "uploading",
        },
      });

      res.json({ success: true, data: updated });
    } catch (err) {
      res.status(500).json({ success: false, error: "Failed to upload audio" });
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

    const audioPath = path.resolve(config.audio.storagePath, meeting.recordingUrl);
    if (!fs.existsSync(audioPath)) {
      res.status(404).json({ success: false, error: "Audio file not found on disk" });
      return;
    }

    res.sendFile(audioPath);
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to download audio" });
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

    // Kick off async processing (non-blocking)
    processMeeting(meeting.id).catch((err) =>
      console.error(`Processing failed for meeting ${meeting.id}:`, err)
    );

    res.json({
      success: true,
      data: { message: "Processing started", meetingId: meeting.id },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to start processing" });
  }
});

// ---------- Async processing pipeline ----------
async function processMeeting(meetingId: string) {
  try {
    // 1. Transcribe
    await prisma.meeting.update({
      where: { id: meetingId },
      data: { status: "transcribing" },
    });

    const meeting = await prisma.meeting.findUniqueOrThrow({
      where: { id: meetingId },
    });
    const audioPath = path.resolve(
      config.audio.storagePath,
      meeting.recordingUrl!
    );

    const { transcribeAudio } = await import("../services/transcription");
    const transcript = await transcribeAudio(audioPath);

    await prisma.meeting.update({
      where: { id: meetingId },
      data: { transcript, status: "summarizing" },
    });

    // 2. Summarize
    const { summarizeMeeting } = await import("../services/summarizer");
    const summary = await summarizeMeeting(transcript, { meetingTitle: meeting.title });

    // Save summary + tasks
    await prisma.meeting.update({
      where: { id: meetingId },
      data: {
        summary: summary.summary,
        bulletPoints: JSON.stringify(summary.bulletPoints),
        topics: JSON.stringify(summary.marketingTopics),
        status: "complete",
        duration: 0, // TODO: derive from audio file
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
  }
}
