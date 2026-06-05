import { Router, Request, Response } from "express";
import { prisma } from "../db";

export const taskRoutes = Router();

// ---------- LIST tasks for a meeting ----------
taskRoutes.get(
  "/meetings/:id/tasks",
  async (req: Request, res: Response) => {
    try {
      const tasks = await prisma.task.findMany({
        where: { meetingId: String(req.params.id) },
        orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
      });

      res.json({ success: true, data: tasks });
    } catch (err) {
      res.status(500).json({ success: false, error: "Failed to list tasks" });
    }
  }
);

// ---------- UPDATE task status ----------
taskRoutes.patch("/tasks/:id", async (req: Request, res: Response) => {
  try {
    const { status, assignee, priority } = req.body;

    const task = await prisma.task.findUnique({
      where: { id: String(req.params.id) },
    });
    if (!task) {
      res.status(404).json({ success: false, error: "Task not found" });
      return;
    }

    const updated = await prisma.task.update({
      where: { id: String(req.params.id) },
      data: {
        ...(status !== undefined && { status }),
        ...(assignee !== undefined && { assignee }),
        ...(priority !== undefined && { priority }),
      },
    });

    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to update task" });
  }
});
