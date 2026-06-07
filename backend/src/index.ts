import express from "express";
import cors from "cors";
import { config } from "./config";
import { prisma } from "./db";
import { meetingRoutes } from "./routes/meetings";
import { transcriptRoutes } from "./routes/transcripts";
import { taskRoutes } from "./routes/tasks";

const app = express();

// ---------- Middleware ----------
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (curl, server-to-server)
      if (!origin) return callback(null, true);
      // Check against configured origins
      if (config.cors.origins.includes(origin)) return callback(null, true);
      // Allow any *.lovableproject.com or *.lovable.app preview URL
      if (origin.endsWith(".lovableproject.com") || origin.endsWith(".lovable.app")) return callback(null, true);
      callback(null, false);
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "X-LLM-Provider",
      "X-LLM-Key",
      "X-LLM-Model",
      "X-LLM-Base-URL",
    ],
  })
);
app.use(express.json({ limit: "1mb" }));

// ---------- Routes ----------
app.get("/api/health", (_req, res) => {
  res.json({ success: true, data: { status: "ok", timestamp: new Date().toISOString() } });
});

app.use("/api/meetings", meetingRoutes);
app.use("/api", transcriptRoutes);
app.use("/api", taskRoutes);

// ---------- Start ----------
async function main() {
  await prisma.$connect();
  console.log("✓ Database connected");

  app.listen(config.port, config.host, () => {
    console.log(`✓ Server running at http://${config.host}:${config.port}`);
    console.log(`✓ LLM provider: ${config.llm.provider}`);
    console.log(`✓ CORS origins: ${config.cors.origins.join(", ")}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
