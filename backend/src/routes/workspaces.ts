import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { requireAuth } from "../middleware/auth";
import {
  requireWorkspaceMembership,
  requireWorkspaceAdmin,
} from "../middleware/workspace";
import { AppError, Errors } from "../utils/errors";

export const workspaceRoutes = Router();

// ── Internal helpers ────────────────────────────────────────────

/** Look up a Supabase user by email using the admin API. */
async function lookupSupabaseUser(email: string): Promise<{ id: string; email: string } | null> {
  const { config } = await import("../config");
  if (config.supabase.serviceRoleKey && config.supabase.url) {
    try {
      const res = await fetch(
        `${config.supabase.url}/auth/v1/admin/users?filter%5Bemail%5D=${encodeURIComponent(email)}`,
        {
          headers: {
            apikey: config.supabase.serviceRoleKey,
            Authorization: `Bearer ${config.supabase.serviceRoleKey}`,
          },
          signal: AbortSignal.timeout(3000),
        },
      );
      if (res.ok) {
        const data = await res.json() as { users?: { id: string; email: string }[] };
        if (data.users && data.users.length > 0) {
          return { id: data.users[0].id, email: data.users[0].email };
        }
      }
    } catch { /* fall through */ }
  }
  return null;
}

// All workspace routes require authentication
workspaceRoutes.use(requireAuth);

// ---------- Helpers ----------

async function uniqueSlug(base: string): Promise<string> {
  let slug = base;
  let attempt = 0;
  while (await prisma.workspace.findUnique({ where: { slug } })) {
    attempt++;
    slug = `${base}-${attempt}`;
  }
  return slug;
}

function formatWorkspace(
  w: { id: string; name: string; slug: string; _count: { members: number }; createdAt: Date },
  role: string,
) {
  return {
    id: w.id,
    name: w.name,
    slug: w.slug,
    role,
    memberCount: w._count.members,
    createdAt: w.createdAt.toISOString(),
  };
}

// ---------- GET /workspaces ----------
workspaceRoutes.get("/", async (req: Request, res: Response) => {
  try {
    const memberships = await prisma.workspaceMember.findMany({
      where: { userId: req.user!.id },
      include: {
        workspace: { include: { _count: { select: { members: true } } } },
      },
      orderBy: { workspace: { createdAt: "asc" } },
    });

    res.json({
      success: true,
      data: {
        workspaces: memberships.map((m) => formatWorkspace(m.workspace, m.role)),
      },
    });
  } catch (err) {
    console.error(" Failed to list workspaces:", err);
    res.status(500).json({ error: "server_error", message: "Failed to list workspaces" });
  }
});

// ---------- POST /workspaces ----------
workspaceRoutes.post("/", async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "validation_error", message: "Workspace name is required" });
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
          create: { userId: req.user!.id, role: "owner" as const },
        },
      },
      include: { _count: { select: { members: true } } },
    });

    res.status(201).json({
      success: true,
      data: formatWorkspace(workspace, "owner"),
    });
  } catch (err) {
    console.error(" Failed to create workspace:", err);
    res.status(500).json({ error: "server_error", message: "Failed to create workspace" });
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
      console.error(" Failed to get workspace:", err);
      res.status(500).json({ error: "server_error", message: "Failed to get workspace" });
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
        res.status(400).json({ error: "validation_error", message: "Workspace name is required" });
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
      console.error(" Failed to update workspace:", err);
      res.status(500).json({ error: "server_error", message: "Failed to update workspace" });
    }
  },
);

// ---------- DELETE /workspaces/:wid ----------
workspaceRoutes.delete(
  "/:wid",
  requireWorkspaceMembership,
  requireWorkspaceAdmin,
  async (req: Request, res: Response) => {
    try {
      // Only owner can delete
      if (req.workspace?.role !== "owner") {
        res.status(403).json({ error: "insufficient_permissions", message: "Only workspace owners can delete workspaces" });
        return;
      }
      await prisma.workspace.delete({ where: { id: String(req.params.wid) } });
      res.json({ success: true, data: { message: "Workspace deleted" } });
    } catch (err) {
      if (err instanceof AppError) throw err;
      console.error(" Failed to delete workspace:", err);
      res.status(500).json({ error: "server_error", message: "Failed to delete workspace" });
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
        orderBy: { createdAt: "asc" },
      });

      // Note: We don't have User model anymore. Members are identified by Supabase UUID.
      // The frontend should fetch user info from Supabase for display.
      res.json({
        success: true,
        data: {
          members: members.map((m) => ({
            id: m.id,
            userId: m.userId,
            role: m.role,
            joinedAt: m.createdAt.toISOString(),
          })),
        },
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      console.error(" Failed to list members:", err);
      res.status(500).json({ error: "server_error", message: "Failed to list members" });
    }
  },
);

// ---------- POST /workspaces/:wid/members ----------
workspaceRoutes.post(
  "/:wid/members",
  requireWorkspaceMembership,
  requireWorkspaceAdmin,
  async (req: Request, res: Response) => {
    try {
      const { userId, role } = req.body;
      if (!userId || typeof userId !== "string") {
        res.status(400).json({ error: "validation_error", message: "userId is required (Supabase UUID)" });
        return;
      }

      const existing = await prisma.workspaceMember.findUnique({
        where: { userId_workspaceId: { userId, workspaceId: String(req.params.wid) } },
      });
      if (existing) {
        res.status(409).json({ error: "conflict", message: "User is already a member" });
        return;
      }

      const memberRole = role === "admin" || role === "member" || role === "viewer" ? role : "member";
      const member = await prisma.workspaceMember.create({
        data: {
          userId,
          workspaceId: String(req.params.wid),
          role: memberRole,
        },
      });

      res.status(201).json({
        success: true,
        data: {
          id: member.id,
          userId: member.userId,
          role: member.role,
          joinedAt: member.createdAt.toISOString(),
        },
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      console.error(" Failed to add member:", err);
      res.status(500).json({ error: "server_error", message: "Failed to add member" });
    }
  },
);

// ---------- PATCH /workspaces/:wid/members/:userId ----------
workspaceRoutes.patch(
  "/:wid/members/:userId",
  requireWorkspaceMembership,
  requireWorkspaceAdmin,
  async (req: Request, res: Response) => {
    try {
      const { role } = req.body;
      if (!role || !["owner", "admin", "member", "viewer"].includes(role)) {
        res.status(400).json({ error: "validation_error", message: "Role must be owner, admin, member, or viewer" });
        return;
      }

      // Protect last owner
      if (role !== "owner") {
        const ownerCount = await prisma.workspaceMember.count({
          where: { workspaceId: String(req.params.wid), role: "owner" },
        });
        if (ownerCount <= 1) {
          const target = await prisma.workspaceMember.findUnique({
            where: { userId_workspaceId: { userId: String(req.params.userId), workspaceId: String(req.params.wid) } },
          });
          if (target?.role === "owner") {
            res.status(400).json({ error: "validation_error", message: "Cannot change the last owner's role" });
            return;
          }
        }
      }

      const updated = await prisma.workspaceMember.update({
        where: { userId_workspaceId: { userId: String(req.params.userId), workspaceId: String(req.params.wid) } },
        data: { role },
      });

      res.json({
        success: true,
        data: {
          id: updated.id,
          userId: updated.userId,
          role: updated.role,
          joinedAt: updated.createdAt.toISOString(),
        },
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      console.error(" Failed to update member:", err);
      res.status(500).json({ error: "server_error", message: "Failed to update member" });
    }
  },
);

// ---------- DELETE /workspaces/:wid/members/:userId ----------
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
        res.status(404).json({ error: "not_found", message: "Member not found" });
        return;
      }

      if (membership.role === "owner") {
        const ownerCount = await prisma.workspaceMember.count({
          where: { workspaceId: String(req.params.wid), role: "owner" },
        });
        if (ownerCount <= 1) {
          res.status(400).json({ error: "validation_error", message: "Cannot remove the last owner" });
          return;
        }
      }

      await prisma.workspaceMember.delete({
        where: { userId_workspaceId: { userId: String(req.params.userId), workspaceId: String(req.params.wid) } },
      });

      res.json({ success: true, data: { message: "Member removed" } });
    } catch (err) {
      if (err instanceof AppError) throw err;
      console.error(" Failed to remove member:", err);
      res.status(500).json({ error: "server_error", message: "Failed to remove member" });
    }
  },
);

// ════════════════════════════════════════════════════════════════
// WORKSPACE INVITES
// ════════════════════════════════════════════════════════════════

// ---------- POST /workspaces/:wid/invites ----------
workspaceRoutes.post(
  "/:wid/invites",
  requireWorkspaceMembership,
  requireWorkspaceAdmin,
  async (req: Request, res: Response) => {
    try {
      const { email, role } = req.body;
      if (!email || typeof email !== "string" || !email.includes("@")) {
        res.status(400).json({ error: "validation_error", message: "Valid email is required" });
        return;
      }

      const normalizedEmail = email.toLowerCase().trim();
      const memberRole = role === "admin" || role === "member" || role === "viewer" ? role : "member";

      // Check existing pending invites to avoid duplicates
      const existing = await prisma.workspaceInvite.findFirst({
        where: {
          workspaceId: String(req.params.wid),
          email: normalizedEmail,
          status: "pending",
        },
      });
      if (existing) {
        res.status(409).json({ error: "conflict", message: "An invite is already pending for this email" });
        return;
      }

      const invite = await prisma.workspaceInvite.create({
        data: {
          email: normalizedEmail,
          role: memberRole,
          status: "pending",
          invitedById: req.user!.id,
          workspaceId: String(req.params.wid),
        },
      });

      res.status(201).json({
        success: true,
        data: {
          id: invite.id,
          email: invite.email,
          role: invite.role,
          status: invite.status,
          createdAt: invite.createdAt.toISOString(),
        },
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      console.error(" Failed to create invite:", err);
      res.status(500).json({ error: "server_error", message: "Failed to create invite" });
    }
  },
);

// ---------- GET /workspaces/:wid/invites ----------
workspaceRoutes.get(
  "/:wid/invites",
  requireWorkspaceMembership,
  requireWorkspaceAdmin,
  async (req: Request, res: Response) => {
    try {
      const invites = await prisma.workspaceInvite.findMany({
        where: { workspaceId: String(req.params.wid) },
        orderBy: { createdAt: "desc" },
      });

      res.json({
        success: true,
        data: {
          invites: invites.map((i) => ({
            id: i.id,
            email: i.email,
            role: i.role,
            status: i.status,
            invitedByUserId: i.invitedById,
            createdAt: i.createdAt.toISOString(),
          })),
        },
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      console.error(" Failed to list invites:", err);
      res.status(500).json({ error: "server_error", message: "Failed to list invites" });
    }
  },
);

// ---------- POST /workspaces/:wid/invites/:inviteId/accept ----------
// Accept an invite. The user must be authenticated and their email must match.
workspaceRoutes.post(
  "/:wid/invites/:inviteId/accept",
  async (req: Request, res: Response) => {
    try {
      const invite = await prisma.workspaceInvite.findUnique({
        where: { id: String(req.params.inviteId) },
      });

      if (!invite || invite.status !== "pending") {
        res.status(404).json({ error: "not_found", message: "Invite not found or already processed" });
        return;
      }

      // The JWT email must match the invited email
      const userEmail = (req.user?.email || "").toLowerCase().trim();
      if (!userEmail || userEmail !== invite.email) {
        res.status(403).json({ error: "forbidden", message: "This invite is for a different email address" });
        return;
      }

      // Check for existing membership
      const membership = await prisma.workspaceMember.findUnique({
        where: { userId_workspaceId: { userId: req.user!.id, workspaceId: invite.workspaceId } },
      });

      if (membership) {
        await prisma.workspaceInvite.update({
          where: { id: invite.id },
          data: { status: "accepted" },
        });
        res.json({ success: true, data: { message: "Already a member", workspaceId: invite.workspaceId } });
        return;
      }

      // Create membership + mark invite accepted
      await prisma.$transaction([
        prisma.workspaceMember.create({
          data: {
            userId: req.user!.id,
            workspaceId: invite.workspaceId,
            role: invite.role,
          },
        }),
        prisma.workspaceInvite.update({
          where: { id: invite.id },
          data: { status: "accepted" },
        }),
      ]);

      res.json({ success: true, data: { message: "Invite accepted", workspaceId: invite.workspaceId } });
    } catch (err) {
      if (err instanceof AppError) throw err;
      console.error(" Failed to accept invite:", err);
      res.status(500).json({ error: "server_error", message: "Failed to accept invite" });
    }
  },
);

// ---------- DELETE /workspaces/:wid/invites/:inviteId ----------
// Cancel/delete a pending invite (admin+)
workspaceRoutes.delete(
  "/:wid/invites/:inviteId",
  requireWorkspaceMembership,
  requireWorkspaceAdmin,
  async (req: Request, res: Response) => {
    try {
      const invite = await prisma.workspaceInvite.findUnique({
        where: { id: String(req.params.inviteId) },
      });
      if (!invite || invite.workspaceId !== String(req.params.wid)) {
        res.status(404).json({ error: "not_found", message: "Invite not found" });
        return;
      }

      await prisma.workspaceInvite.delete({ where: { id: invite.id } });
      res.json({ success: true, data: { message: "Invite cancelled" } });
    } catch (err) {
      if (err instanceof AppError) throw err;
      console.error(" Failed to cancel invite:", err);
      res.status(500).json({ error: "server_error", message: "Failed to cancel invite" });
    }
  },
);

// ---------- POST /workspaces/:wid/resolve-email ----------
// Given an email, return the Supabase user ID if they have an account.
// This is used by the frontend to add members by email.
workspaceRoutes.post(
  "/:wid/resolve-email",
  requireWorkspaceMembership,
  requireWorkspaceAdmin,
  async (req: Request, res: Response) => {
    try {
      const { email } = req.body;
      if (!email || typeof email !== "string") {
        res.status(400).json({ error: "validation_error", message: "Email is required" });
        return;
      }

      const user = await lookupSupabaseUser(email.toLowerCase().trim());
      if (!user) {
        res.status(404).json({ error: "not_found", message: "No user found with this email. They need to sign up first." });
        return;
      }

      res.json({ success: true, data: { userId: user.id, email: user.email } });
    } catch (err) {
      if (err instanceof AppError) throw err;
      console.error(" Failed to resolve email:", err);
      res.status(500).json({ error: "server_error", message: "Failed to resolve email" });
    }
  },
);
