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
    origin: config.cors.origins,
    methods: ["GET", "POST", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type"],
  })
);
app.use(express.json());

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
