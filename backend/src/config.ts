import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

// ── Derive Supabase project ref from SUPABASE_URL if not explicitly set ──
function deriveProjectRef(url: string): string {
  const match = url.match(/https:\/\/(.+)\.supabase\.co/);
  return match ? match[1] : "";
}

const supabaseUrl = process.env.SUPABASE_URL || "";
const explicitRef = process.env.SUPABASE_PROJECT_REF || "";
const projectRef = explicitRef || deriveProjectRef(supabaseUrl);

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
    storagePath: path.resolve(__dirname, "..", process.env.AUDIO_STORAGE_PATH || "./audio"),
  },

  storage: {
    provider: (process.env.STORAGE_PROVIDER || "local") as "local" | "supabase",
    supabase: {
      url: supabaseUrl,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
      bucket: process.env.SUPABASE_STORAGE_BUCKET || "meeting-audio",
    },
  },

  stt: {
    provider: process.env.STT_PROVIDER || "local",
    deepgram: {
      apiKey: process.env.DEEPGRAM_API_KEY || "",
      model: process.env.STT_DEEPGRAM_MODEL || "nova-3",
      keywords: process.env.DEEPGRAM_KEYWORDS || "",
      filterFiller: process.env.DEEPGRAM_FILTER_FILLER !== "false",
    },
  },

  audioNormalization: {
    enabled: process.env.AUDIO_NORMALIZE !== "false",
    targetLoudness: parseFloat(process.env.AUDIO_TARGET_LOUDNESS || "-14"),
    clarityMode: process.env.AUDIO_CLARITY_MODE || "speech",
  },

  whisper: {
    modelSize: process.env.WHISPER_MODEL_SIZE || "base",
    language: process.env.WHISPER_LANGUAGE || "en",
    vadFilter: process.env.WHISPER_VAD_FILTER !== "false",
    vadThreshold: parseFloat(process.env.WHISPER_VAD_THRESHOLD || "0.4"),
    contextWords: process.env.WHISPER_CONTEXT_WORDS || "",
  },

  cors: {
    origins: (process.env.CORS_ORIGINS || "http://localhost:5173")
      .split(",")
      .map((s) => s.trim()),
  },

  // ── Supabase Auth — single source of truth from SUPABASE_URL ──
  supabase: {
    url: supabaseUrl,

    // JWKS URL derived automatically from SUPABASE_URL
    jwksUrl:
      process.env.SUPABASE_JWKS_URL ||
      (supabaseUrl ? `${supabaseUrl}/auth/v1/.well-known/jwks.json` : ""),

    // Project ref derived automatically from SUPABASE_URL
    projectRef,

    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  },
};

// ── Startup diagnostics ──
export function logConfig(): void {
  console.log("  Config:");
  console.log(`    SUPABASE_URL:       ${config.supabase.url || "(not set)"}`);
  console.log(`    SUPABASE_PROJECT_REF: ${config.supabase.projectRef || "(not set — derived from URL)"}`);
  console.log(`    SUPABASE_JWKS_URL:  ${config.supabase.jwksUrl || "(not set)"}`);
  console.log(`    Service role key:   ${config.supabase.serviceRoleKey ? "(set)" : "(not set)"}`);
  console.log(`    Email verify check: ${config.supabase.serviceRoleKey ? "enabled" : "JWT claim only"}`);
}
