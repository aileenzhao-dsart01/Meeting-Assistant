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
    res.status(400).json({ success: false, error: "Workspace ID missing in URL" });
    return;
  }

  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: "Authentication required" });
    return;
  }

  try {
    const membership = await prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId, workspaceId: String(wid) } },
    });

    if (!membership) {
      res.status(403).json({ success: false, error: "Not a member of this workspace" });
      return;
    }

    req.workspace = { id: wid, role: membership.role as WorkspaceRole };
    next();
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to verify workspace membership" });
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
    res.status(403).json({ success: false, error: "Admin access required" });
    return;
  }
  next();
}

/**
 * requireWorkspaceOwner — expects `req.workspace` to already be set and checks
 * the role is owner.
 */
export function requireWorkspaceOwner(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.workspace?.role !== "owner") {
    res.status(403).json({ success: false, error: "Owner access required" });
    return;
  }
  next();
}
