import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { requireAuth } from "../middleware/auth";
import {
  requireWorkspaceMembership,
  requireWorkspaceAdmin,
  requireWorkspaceOwner,
} from "../middleware/workspace";
import { AppError, Errors } from "../utils/errors";

export const workspaceRoutes = Router();

// All workspace routes require authentication
workspaceRoutes.use(requireAuth);

// ---------- Helpers ----------

/** Ensure a workspace slug is unique by appending -N if needed. */
async function uniqueSlug(base: string): Promise<string> {
  let slug = base;
  let attempt = 0;
  while (await prisma.workspace.findUnique({ where: { slug } })) {
    attempt++;
    slug = `${base}-${attempt}`;
  }
  return slug;
}

function formatWorkspace(w: {
  id: string; name: string; slug: string;
  _count: { members: number };
  createdAt: Date;
}, role: string) {
  return {
    id: w.id,
    name: w.name,
    slug: w.slug,
    role,
    memberCount: w._count.members,
    createdAt: w.createdAt.toISOString(),
  };
}

function formatMember(m: {
  id: string; role: string; createdAt: Date;
  user: { id: string; email: string; name: string | null };
}) {
  return {
    id: m.id,
    userId: m.user.id,
    email: m.user.email,
    name: m.user.name,
    role: m.role,
    joinedAt: m.createdAt.toISOString(),
  };
}

// ---------- GET /workspaces ----------
// List the authenticated user's workspaces
workspaceRoutes.get("/", async (req: Request, res: Response) => {
  try {
    const memberships = await prisma.workspaceMember.findMany({
      where: { userId: req.user!.id },
      include: {
        workspace: {
          include: { _count: { select: { members: true } } },
        },
      },
      orderBy: { workspace: { createdAt: "asc" } },
    });

    const workspaces = memberships.map((m) =>
      formatWorkspace(m.workspace, m.role)
    );

    res.json({ success: true, data: { workspaces } });
  } catch (err) {
    console.error("✗ Failed to list workspaces:", err);
    res.status(500).json({ success: false, error: "Failed to list workspaces" });
  }
});

// ---------- POST /workspaces ----------
// Create a workspace (creator becomes owner)
workspaceRoutes.post("/", async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ success: false, error: "Workspace name is required" });
      return;
    }

    const slugBase = name
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/^-+|-+$/g, "") || "workspace";

    const slug = await uniqueSlug(slugBase);

    const workspace = await prisma.workspace.create({
      data: {
        name: name.trim(),
        slug,
        members: {
          create: { userId: req.user!.id, role: "owner" },
        },
      },
      include: { _count: { select: { members: true } } },
    });

    res.status(201).json({
      success: true,
      data: formatWorkspace(workspace, "owner"),
    });
  } catch (err) {
    console.error("✗ Failed to create workspace:", err);
    res.status(500).json({ success: false, error: "Failed to create workspace" });
  }
});

// ---------- GET /workspaces/:wid ----------
workspaceRoutes.get(
  "/:wid",
  requireWorkspaceMembership,
  async (req: Request, res: Response) => {
    try {
      const workspace = await prisma.workspace.findUnique({
        where: { id: String(req.params.wid) },
        include: { _count: { select: { members: true } } },
      });

      if (!workspace) throw Errors.notFound("Workspace not found");

      res.json({
        success: true,
        data: formatWorkspace(workspace, req.workspace!.role),
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      console.error("✗ Failed to get workspace:", err);
      res.status(500).json({ success: false, error: "Failed to get workspace" });
    }
  },
);

// ---------- PATCH /workspaces/:wid ----------
workspaceRoutes.patch(
  "/:wid",
  requireWorkspaceMembership,
  requireWorkspaceAdmin,
  async (req: Request, res: Response) => {
    try {
      const { name } = req.body;
      if (!name || typeof name !== "string" || !name.trim()) {
        res.status(400).json({ success: false, error: "Workspace name is required" });
        return;
      }

      const updated = await prisma.workspace.update({
        where: { id: String(req.params.wid) },
        data: { name: name.trim() },
        include: { _count: { select: { members: true } } },
      });

      res.json({
        success: true,
        data: formatWorkspace(updated, req.workspace!.role),
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      console.error("✗ Failed to update workspace:", err);
      res.status(500).json({ success: false, error: "Failed to update workspace" });
    }
  },
);

// ---------- DELETE /workspaces/:wid ----------
workspaceRoutes.delete(
  "/:wid",
  requireWorkspaceMembership,
  requireWorkspaceOwner,
  async (req: Request, res: Response) => {
    try {
      await prisma.workspace.delete({ where: { id: String(req.params.wid) } });
      res.json({ success: true, data: { message: "Workspace deleted" } });
    } catch (err) {
      if (err instanceof AppError) throw err;
      console.error("✗ Failed to delete workspace:", err);
      res.status(500).json({ success: false, error: "Failed to delete workspace" });
    }
  },
);

// ---------- GET /workspaces/:wid/members ----------
workspaceRoutes.get(
  "/:wid/members",
  requireWorkspaceMembership,
  async (req: Request, res: Response) => {
    try {
      const members = await prisma.workspaceMember.findMany({
        where: { workspaceId: String(req.params.wid) },
        include: {
          user: { select: { id: true, email: true, name: true } },
        },
        orderBy: { createdAt: "asc" },
      });

      res.json({
        success: true,
        data: { members: members.map(formatMember) },
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      console.error("✗ Failed to list members:", err);
      res.status(500).json({ success: false, error: "Failed to list members" });
    }
  },
);

// ---------- POST /workspaces/:wid/members ----------
// Add a member by email (admin+)
workspaceRoutes.post(
  "/:wid/members",
  requireWorkspaceMembership,
  requireWorkspaceAdmin,
  async (req: Request, res: Response) => {
    try {
      const { email, role } = req.body;
      if (!email || typeof email !== "string") {
        res.status(400).json({ success: false, error: "User email is required" });
        return;
      }

      const user = await prisma.user.findUnique({
        where: { email: email.toLowerCase().trim() },
      });
      if (!user) {
        res.status(404).json({ success: false, error: "No user found with this email" });
        return;
      }

      // Check if already a member
      const existing = await prisma.workspaceMember.findUnique({
        where: { userId_workspaceId: { userId: user.id, workspaceId: String(req.params.wid) } },
      });
      if (existing) {
        res.status(409).json({ success: false, error: "User is already a member of this workspace" });
        return;
      }

      const memberRole = role === "admin" || role === "member" ? role : "member";
      const member = await prisma.workspaceMember.create({
        data: {
          userId: user.id,
          workspaceId: String(req.params.wid),
          role: memberRole,
        },
        include: {
          user: { select: { id: true, email: true, name: true } },
        },
      });

      res.status(201).json({
        success: true,
        data: formatMember(member),
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      console.error("✗ Failed to add member:", err);
      res.status(500).json({ success: false, error: "Failed to add member" });
    }
  },
);

// ---------- PATCH /workspaces/:wid/members/:userId ----------
// Change member role (admin+)
workspaceRoutes.patch(
  "/:wid/members/:userId",
  requireWorkspaceMembership,
  requireWorkspaceAdmin,
  async (req: Request, res: Response) => {
    try {
      const { role } = req.body;
      if (!role || !["owner", "admin", "member"].includes(role)) {
        res.status(400).json({ success: false, error: "Role must be owner, admin, or member" });
        return;
      }

      // Don't allow changing the last owner's role
      if (role !== "owner") {
        const ownerCount = await prisma.workspaceMember.count({
          where: { workspaceId: String(req.params.wid), role: "owner" },
        });
        if (ownerCount <= 1) {
          const target = await prisma.workspaceMember.findUnique({
            where: { userId_workspaceId: { userId: String(req.params.userId), workspaceId: String(req.params.wid) } },
          });
          if (target?.role === "owner") {
            res.status(400).json({ success: false, error: "Cannot change the last owner's role" });
            return;
          }
        }
      }

      const updated = await prisma.workspaceMember.update({
        where: { userId_workspaceId: { userId: String(req.params.userId), workspaceId: String(req.params.wid) } },
        data: { role },
        include: {
          user: { select: { id: true, email: true, name: true } },
        },
      });

      res.json({ success: true, data: formatMember(updated) });
    } catch (err) {
      if (err instanceof AppError) throw err;
      console.error("✗ Failed to update member:", err);
      res.status(500).json({ success: false, error: "Failed to update member" });
    }
  },
);

// ---------- DELETE /workspaces/:wid/members/:userId ----------
// Remove a member (admin+, cannot remove self if last owner)
workspaceRoutes.delete(
  "/:wid/members/:userId",
  requireWorkspaceMembership,
  requireWorkspaceAdmin,
  async (req: Request, res: Response) => {
    try {
      const membership = await prisma.workspaceMember.findUnique({
        where: { userId_workspaceId: { userId: String(req.params.userId), workspaceId: String(req.params.wid) } },
      });
      if (!membership) {
        res.status(404).json({ success: false, error: "Member not found" });
        return;
      }

      // Prevent removing the last owner
      if (membership.role === "owner") {
        const ownerCount = await prisma.workspaceMember.count({
          where: { workspaceId: String(req.params.wid), role: "owner" },
        });
        if (ownerCount <= 1) {
          res.status(400).json({ success: false, error: "Cannot remove the last owner" });
          return;
        }
      }

      await prisma.workspaceMember.delete({
        where: { userId_workspaceId: { userId: String(req.params.userId), workspaceId: String(req.params.wid) } },
      });

      res.json({ success: true, data: { message: "Member removed" } });
    } catch (err) {
      if (err instanceof AppError) throw err;
      console.error("✗ Failed to remove member:", err);
      res.status(500).json({ success: false, error: "Failed to remove member" });
    }
  },
);
