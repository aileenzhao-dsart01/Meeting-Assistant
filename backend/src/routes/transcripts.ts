import { Router, Request, Response } from "express";
import { prisma } from "../db";

export const transcriptRoutes = Router();

// ---------- GET transcript ----------
transcriptRoutes.get(
  "/meetings/:id/transcript",
  async (req: Request, res: Response) => {
    try {
      const meeting = await prisma.meeting.findUnique({
        where: { id: String(req.params.id) },
        select: { transcript: true, status: true },
      });

      if (!meeting) {
        res.status(404).json({ success: false, error: "Meeting not found" });
        return;
      }

      res.json({ success: true, data: meeting });
    } catch (err) {
      res
        .status(500)
        .json({ success: false, error: "Failed to get transcript" });
    }
  }
);

// ---------- GET summary ----------
transcriptRoutes.get(
  "/meetings/:id/summary",
  async (req: Request, res: Response) => {
    try {
      const meeting = await prisma.meeting.findUnique({
        where: { id: String(req.params.id) },
        select: {
          summary: true,
          bulletPoints: true,
          topics: true,
          status: true,
        },
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
        },
      });
    } catch (err) {
      res
        .status(500)
        .json({ success: false, error: "Failed to get summary" });
    }
  }
);
