import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { requireAuth } from "../middleware/auth";
import { AppError, Errors } from "../utils/errors";

export const userRoutes = Router();

userRoutes.use(requireAuth);

// ---------- GET /me/invites ----------
// Returns all pending workspace invites for the authenticated user's email.
userRoutes.get("/invites", async (req: Request, res: Response) => {
  try {
    const userEmail = (req.user?.email || "").toLowerCase().trim();
    if (!userEmail) {
      res.status(400).json({ error: "validation_error", message: "No email on account" });
      return;
    }

    const invites = await prisma.workspaceInvite.findMany({
      where: { email: userEmail, status: "pending" },
      include: {
        workspace: { select: { id: true, name: true, slug: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({
      success: true,
      data: {
        invites: invites.map((i) => ({
          id: i.id,
          workspaceId: i.workspace.id,
          workspaceName: i.workspace.name,
          workspaceSlug: i.workspace.slug,
          role: i.role,
          status: i.status,
          createdAt: i.createdAt.toISOString(),
          acceptLink: `${process.env.APP_URL || "http://localhost:5173"}/invite/${i.id}?w=${i.workspaceId}`,
        })),
      },
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    console.error(" Failed to list invites:", err);
    res.status(500).json({ error: "server_error", message: "Failed to list invites" });
  }
});
