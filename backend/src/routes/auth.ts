import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { prisma } from "../db";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../utils/errors";

export const authRoutes = Router();

// ---------- Helpers ----------

function generateToken(userId: string, email: string): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jwt.sign({ userId, email }, config.jwt.secret, { expiresIn: config.jwt.expiresIn } as any);
}

/** Create a personal workspace for a new user and add them as owner. */
async function createPersonalWorkspace(userId: string, userName: string | null): Promise<{ id: string; name: string; slug: string }> {
  const baseName = userName ? `${userName.split(" ")[0]}'s Workspace` : "My Workspace";
  const baseSlug = baseName
    .toLowerCase()
    .replace(/['\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "");

  // Ensure unique slug
  let slug = baseSlug;
  let attempt = 1;
  while (await prisma.workspace.findUnique({ where: { slug } })) {
    attempt++;
    slug = `${baseSlug}-${attempt}`;
  }

  const workspace = await prisma.workspace.create({
    data: {
      name: baseName,
      slug,
      members: { create: { userId, role: "owner" } },
    },
  });

  return { id: workspace.id, name: workspace.name, slug: workspace.slug };
}

// ---------- POST /register ----------
authRoutes.post("/register", async (req: Request, res: Response) => {
  try {
    const { email, password, name } = req.body;

    if (!email || typeof email !== "string" || !email.includes("@")) {
      res.status(400).json({ success: false, error: "Valid email is required" });
      return;
    }
    if (!password || typeof password !== "string" || password.length < 6) {
      res.status(400).json({ success: false, error: "Password must be at least 6 characters" });
      return;
    }

    // Check for existing user
    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (existing) {
      res.status(409).json({ success: false, error: "An account with this email already exists" });
      return;
    }

    const normalizedEmail = email.toLowerCase().trim();
    const passwordHash = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        name: name?.trim() || null,
      },
    });

    // Auto-create personal workspace
    const workspace = await createPersonalWorkspace(user.id, user.name);

    const token = generateToken(user.id, user.email);
    const workspaces = [{ ...workspace, role: "owner" }];

    res.status(201).json({
      success: true,
      data: {
        user: { id: user.id, email: user.email, name: user.name },
        token,
        workspaces,
      },
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    console.error("✗ Registration failed:", err);
    res.status(500).json({ success: false, error: "Registration failed" });
  }
});

// ---------- POST /login ----------
authRoutes.post("/login", async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ success: false, error: "Email and password are required" });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      include: {
        memberships: {
          include: { workspace: { select: { id: true, name: true, slug: true } } },
        },
      },
    });

    if (!user) {
      res.status(401).json({ success: false, error: "Invalid email or password" });
      return;
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ success: false, error: "Invalid email or password" });
      return;
    }

    const token = generateToken(user.id, user.email);
    const workspaces = user.memberships.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      slug: m.workspace.slug,
      role: m.role,
    }));

    res.json({
      success: true,
      data: {
        user: { id: user.id, email: user.email, name: user.name },
        token,
        workspaces,
      },
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    console.error("✗ Login failed:", err);
    res.status(500).json({ success: false, error: "Login failed" });
  }
});

// ---------- GET /me ----------
authRoutes.get("/me", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: {
        memberships: {
          include: { workspace: { select: { id: true, name: true, slug: true } } },
        },
      },
    });

    if (!user) {
      res.status(404).json({ success: false, error: "User not found" });
      return;
    }

    const workspaces = user.memberships.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      slug: m.workspace.slug,
      role: m.role,
    }));

    res.json({
      success: true,
      data: {
        user: { id: user.id, email: user.email, name: user.name },
        workspaces,
      },
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    console.error("✗ Failed to get user:", err);
    res.status(500).json({ success: false, error: "Failed to get user" });
  }
});
