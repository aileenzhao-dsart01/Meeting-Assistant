import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

export const config = {
  port: parseInt(process.env.PORT || "3001", 10),
  host: process.env.HOST || "0.0.0.0",

  llm: {
    provider: process.env.LLM_PROVIDER || "deepseek",
    deepseek: {
      apiKey: process.env.DEEPSEEK_API_KEY || "",
      model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
    },
  },

  audio: {
    storagePath: path.resolve(
      __dirname,
      "..",
      process.env.AUDIO_STORAGE_PATH || "./audio"
    ),
  },

  whisper: {
    modelSize: process.env.WHISPER_MODEL_SIZE || "base",
    language: process.env.WHISPER_LANGUAGE || "en",
    vadFilter: process.env.WHISPER_VAD_FILTER !== "false",
    vadThreshold: parseFloat(process.env.WHISPER_VAD_THRESHOLD || "0.4"),
  },

  cors: {
    origins: (process.env.CORS_ORIGINS || "http://localhost:5173")
      .split(",")
      .map((s) => s.trim()),
  },
} as const;
