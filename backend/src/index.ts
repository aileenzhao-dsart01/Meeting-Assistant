import express from "express";
import cors from "cors";
import { config } from "./config";
import { prisma } from "./db";
import { workspaceRoutes } from "./routes/workspaces";
import { meetingRoutes } from "./routes/meetings";
import { legacyMeetingRoutes } from "./routes/legacy-meetings";
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

// ---------- Global error handler (must be last) ----------
app.use(errorHandler);

// ---------- Start ----------
async function main() {
  await prisma.$connect();
  console.log(" Database connected");

  app.listen(config.port, config.host, () => {
    console.log(` Server running at http://${config.host}:${config.port}`);
    console.log(` LLM provider: ${config.llm.provider}`);
    console.log(` CORS origins: ${config.cors.origins.join(", ")}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
