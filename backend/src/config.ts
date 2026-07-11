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

  storage: {
    // "local" or "supabase" — local files are lost on Render restarts
    provider: process.env.STORAGE_PROVIDER || "local",
    supabase: {
      url: process.env.SUPABASE_URL || "",
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
      bucket: process.env.SUPABASE_STORAGE_BUCKET || "meeting-audio",
    },
  },

  stt: {
    // "local" = faster-whisper (Python), "deepgram" = Deepgram Nova-3 (cloud)
    provider: process.env.STT_PROVIDER || "local",
    deepgram: {
      apiKey: process.env.DEEPGRAM_API_KEY || "",
      model: process.env.STT_DEEPGRAM_MODEL || "nova-3",
      // Comma-separated keyterms to boost (speaker names, jargon, brand terms)
      // Each term can have a weight: "term:weight" — higher weight = more bias
      // Example: "Ran Zhao:5,PPC:3,ROAS:3,LinkedIn Ads:2"
      keywords: process.env.DEEPGRAM_KEYWORDS || "",
      // Strip filler words (um, uh, like, you know) from transcript
      filterFiller: process.env.DEEPGRAM_FILTER_FILLER !== "false",
    },
  },

  audioNormalization: {
    enabled: process.env.AUDIO_NORMALIZE !== "false",
    // Target loudness in dB (LUFS). -16 to -14 is typical for speech.
    targetLoudness: parseFloat(process.env.AUDIO_TARGET_LOUDNESS || "-14"),
    // Audio clarity enhancement:
    // "basic"   = rumble removal + volume boost (fast, safe)
    // "speech"  = basic + speech-band EQ (recommended — no voice distortion)
    // "max"     = speech + gentle compression (for very quiet recordings)
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

  supabase: {
    url: process.env.SUPABASE_URL || "",
    jwksUrl:
      process.env.SUPABASE_JWKS_URL ||
      `${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
    projectRef: process.env.SUPABASE_PROJECT_REF || "",
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  },

} as const;
