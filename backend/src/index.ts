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
app.get("/api/health", async (_req, res) => {
  try {
    // Real liveness check — verify the DB is reachable, not just that the
    // process is up. Render's health check should reflect the true state.
    await prisma.$queryRaw`SELECT 1`;
    res.json({ success: true, data: { status: "ok", timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error(" Health check failed — DB unreachable:", err);
    res.status(503).json({ success: false, data: { status: "db_unreachable" } });
  }
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

// ---------- Process-level crash protection ----------
// Node's default is to kill the whole process on an unhandled rejection or
// exception. One stray async error (a fetch in storage, a bug in a route)
// would otherwise take down the server for a 30-60s cold start. Log loudly
// but keep serving; on Render, a lingering crash loops into a restart storm.
process.on("uncaughtException", (err) => {
  console.error(" Uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error(" Unhandled rejection:", reason);
});

// ---------- Start ----------
// Retry the initial DB connection with backoff so a transient Supabase/Postgres
// blip at boot (cold start, maintenance) can't leave the server permanently down.
async function connectWithRetry(maxAttempts = 5): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await prisma.$connect();
      console.log(" Database connected");
      return;
    } catch (err) {
      const isLast = attempt === maxAttempts;
      console.error(
        ` DB connect failed (attempt ${attempt}/${maxAttempts})${isLast ? "" : " — retrying..."}:`,
        err instanceof Error ? err.message : err
      );
      if (isLast) throw err;
      await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 1000, 15_000)));
    }
  }
}

async function main() {
  await connectWithRetry();

  await recoverInterruptedMeetings();

  const server = app.listen(config.port, config.host, () => {
    console.log(` Server running at http://${config.host}:${config.port}`);
    console.log(` LLM provider: ${config.llm.provider}`);
    console.log(` CORS origins: ${config.cors.origins.join(", ")}`);
    logConfig();
  });

  // ---------- Graceful shutdown ----------
  // Render sends SIGTERM on deploy/restart. Stop accepting new connections,
  // give in-flight requests a moment to finish, then close the DB pool.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n Received ${signal} — shutting down gracefully...`);

    const forceTimer = setTimeout(() => {
      console.error(" Graceful shutdown timed out — forcing exit");
      process.exit(1);
    }, 15_000);
    forceTimer.unref();

    server.close(async () => {
      try {
        await prisma.$disconnect();
      } catch (err) {
        console.error(" Error disconnecting DB during shutdown:", err);
      }
      console.log(" Shutdown complete");
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
