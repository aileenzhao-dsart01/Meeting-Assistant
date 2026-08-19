import express from "express";
import cors from "cors";
import { config, logConfig } from "./config";
import { prisma } from "./db";
import { workspaceRoutes } from "./routes/workspaces";
import { meetingRoutes } from "./routes/meetings";
import { legacyMeetingRoutes } from "./routes/legacy-meetings";
import { userRoutes } from "./routes/me";
import { requireAuth } from "./middleware/auth";
import { requireWorkspaceMembership } from "./middleware/workspace";
import { errorHandler } from "./middleware/errorHandler";

const app = express();

// ---------- Middleware ----------
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (config.cors.origins.includes(origin)) return callback(null, true);
      if (
        origin === "https://compassmeetings.com" ||
        origin.endsWith(".lovableproject.com") ||
        origin.endsWith(".lovable.app") ||
        origin.endsWith(".onrender.com")
      )
        return callback(null, true);
      callback(null, false);
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-LLM-Provider",
      "X-LLM-Key",
      "X-LLM-Model",
      "X-LLM-Base-URL",
    ],
    exposedHeaders: ["Content-Disposition"],
  })
);
app.use(express.json({ limit: "1mb" }));

// ---------- Routes ----------
app.get("/api/health", (_req, res) => {
  res.json({ success: true, data: { status: "ok", timestamp: new Date().toISOString() } });
});

// Workspaces (CRUD + member management)
app.use("/api/workspaces", workspaceRoutes);

// Workspace-scoped meetings (primary API) — auth + membership verified at mount
app.use("/api/workspaces/:wid/meetings", requireAuth, requireWorkspaceMembership, meetingRoutes);

// Legacy flat meeting routes (backward compat)
app.use("/api/meetings", legacyMeetingRoutes);

// Current user — profile, invites, etc.
app.use("/api/me", userRoutes);

// ---------- Global error handler (must be last) ----------
app.use(errorHandler);

// ---------- Crash recovery ----------
// If the server died mid-processing (deploy, OOM, Render reap), meetings can be
// stuck in "transcribing"/"summarizing" forever. Reset them so the user can re-run.
async function recoverInterruptedMeetings(): Promise<void> {
  const interrupted = await prisma.meeting.findMany({
    where: { status: { in: ["transcribing", "summarizing"] } },
    select: { id: true },
  });
  if (interrupted.length > 0) {
    await prisma.meeting.updateMany({
      where: { id: { in: interrupted.map((m) => m.id) } },
      data: {
        status: "error",
        error: "Processing was interrupted by a server restart — please re-run processing.",
      },
    });
    console.log(` Recovered ${interrupted.length} interrupted meeting(s) → status "error"`);
  }

  // Meetings stuck in "uploading" (crash between save and DB update) → pending
  const stuckUploads = await prisma.meeting.findMany({
    where: { status: "uploading" },
    select: { id: true },
  });
  if (stuckUploads.length > 0) {
    await prisma.meeting.updateMany({
      where: { id: { in: stuckUploads.map((m) => m.id) } },
      data: { status: "pending" },
    });
    console.log(` Reset ${stuckUploads.length} stuck upload(s) → status "pending"`);
  }
}

// ---------- Start ----------
async function main() {
  await prisma.$connect();
  console.log(" Database connected");

  await recoverInterruptedMeetings();

  app.listen(config.port, config.host, () => {
    console.log(` Server running at http://${config.host}:${config.port}`);
    console.log(` LLM provider: ${config.llm.provider}`);
    console.log(` CORS origins: ${config.cors.origins.join(", ")}`);
    logConfig();
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
