import { Request, Response, NextFunction } from "express";
import { prisma } from "../db";
import { WorkspaceRole } from "../types";

/**
 * requireWorkspaceMembership — checks `req.params.wid` (workspace ID) and
 * verifies the authenticated user is a member. Attaches `req.workspace = { id, role }`.
 *
 * Must be used AFTER `requireAuth` (needs `req.user`).
 */
export async function requireWorkspaceMembership(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const wid = String(req.params.wid);
  if (!wid) {
    res.status(400).json({ error: "validation_error", message: "Workspace ID missing in URL" });
    return;
  }

  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: "unauthorized", message: "Authentication required" });
    return;
  }

  try {
    const membership = await prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId, workspaceId: wid } },
    });

    if (!membership) {
      res.status(403).json({ error: "not_a_member", message: "Not a member of this workspace" });
      return;
    }

    req.workspace = { id: wid, role: membership.role as WorkspaceRole };
    next();
  } catch (err) {
    console.error(" Workspace membership check failed:", err);
    res.status(500).json({ error: "server_error", message: "Failed to verify workspace membership" });
  }
}

/**
 * requireWorkspaceAdmin — expects `req.workspace` to already be set (by
 * `requireWorkspaceMembership`) and checks the role is owner or admin.
 */
export function requireWorkspaceAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const role = req.workspace?.role;
  if (!role || (role !== "owner" && role !== "admin")) {
    res.status(403).json({ error: "insufficient_permissions", message: "Admin access required" });
    return;
  }
  next();
}
