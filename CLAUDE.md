# Meeting Assistant — Marketing Team Transcription & Summarization

## Project Overview

A backend service that records, transcribes, and summarizes marketing team meetings. The frontend dashboard is built in **Lovable** and consumes the REST API here.

**Core flow:** Browser records audio → Upload to API → Audio normalization (ffmpeg) → **STT** (faster-whisper locally or Deepgram Nova-3 cloud) → DeepSeek/LLM summarizes → Dashboard displays transcript + bullet points + tasks + future prospects.

## Tech Stack

- **Backend:** Node.js + TypeScript + Express
- **Database:** PostgreSQL (Supabase) via Prisma ORM
- **STT:** faster-whisper (local Python) or Deepgram Nova-3 (cloud, $200 free credit — no card needed)
- **LLM:** DeepSeek API (OpenAI-compatible), with provider abstraction for Claude/OpenAI swap
- **Frontend:** Lovable (separate project, consumes this API)

## Project Structure

```
backend/
├── src/
│   ├── index.ts              # Express server entry
│   ├── config.ts             # Environment configuration (STT provider, LLM, audio)
│   ├── db.ts                 # Prisma client (PostgreSQL with Supabase pooler)
│   ├── routes/
│   │   ├── meetings.ts       # Meeting CRUD + audio upload + async processing
│   │   ├── transcripts.ts    # Transcript & summary endpoints
│   │   └── tasks.ts          # Task list & update endpoints
│   └── services/
│       ├── transcription.ts  # STT orchestration — local Whisper or Deepgram cloud + ffmpeg audio normalization
│       ├── summarizer.ts     # Summary generation (LLM)
│       └── llm/
│           ├── interface.ts  # Provider abstraction interface
│           ├── deepseek.ts   # DeepSeek implementation
│           ├── claude.ts     # Future
│           └── openai.ts     # Future
├── scripts/
│   └── transcribe.py         # faster-whisper Python script
├── prisma/
│   └── schema.prisma
└── audio/                    # Uploaded audio files (gitignored)
```

## Getting Started

```bash
cd backend

# Install Node.js dependencies
npm install

# Install Python dependencies (for local whisper transcription)
pip install faster-whisper

# (Optional) Install ffmpeg for audio normalization
brew install ffmpeg

# Copy env and set your API keys
cp .env.example .env
# Edit .env → set DEEPSEEK_API_KEY=sk-...
# For cloud STT: set STT_PROVIDER=deepgram and DEEPGRAM_API_KEY (get free at deepgram.com)

# Generate Prisma client & sync database schema
npx prisma generate
npx prisma db push

# Start dev server
npm run dev
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/meetings` | List meetings (`?status=complete&page=1&limit=20`) |
| `POST` | `/api/meetings` | Create meeting `{ title: string }` |
| `GET` | `/api/meetings/:id` | Get meeting with transcript, summary & tasks |
| `DELETE` | `/api/meetings/:id` | Delete meeting |
| `POST` | `/api/meetings/:id/audio` | Upload audio (multipart/form-data, field: `audio`) |
| `GET` | `/api/meetings/:id/audio` | Download original audio |
| `POST` | `/api/meetings/:id/process` | Start transcription + summarization |
| `GET` | `/api/meetings/:id/transcript` | Get transcript text |
| `GET` | `/api/meetings/:id/summary` | Get structured summary |
| `GET` | `/api/meetings/:id/tasks` | List tasks for a meeting |
| `PATCH` | `/api/tasks/:id` | Update task `{ status: "done" }` |

## Adding an LLM Provider

1. Create `src/services/llm/<name>.ts` implementing `LLMProvider` interface
2. Add the case in `src/services/llm/index.ts` factory
3. Add config keys in `src/config.ts` and `.env`

## Deployment (Render)

The project includes `render.yaml` for one-click deploy on [Render](https://render.com) free tier.

**Limitations on Render free tier:**
- ❌ No Python runtime — local Whisper won't work
- ❌ No ffmpeg — audio normalization disabled
- ✅ **Deepgram Nova-3** cloud STT works (set `DEEPGRAM_API_KEY`)
- ✅ DeepSeek summarization works
- ✅ All API endpoints work
- ✅ Audio file storage works (ephemeral disk)

**Required env vars for Render:**
| Key | Value |
|-----|-------|
| `DATABASE_URL` | Supabase pooler connection string |
| `DEEPSEEK_API_KEY` | Your DeepSeek API key |
| `STT_PROVIDER` | `deepgram` |
| `DEEPGRAM_API_KEY` | Your Deepgram API key (free at deepgram.com) |
| `CORS_ORIGINS` | Your Lovable frontend URL |

## Architecture

```
Backend (this repo)        Frontend (Lovable)
─────────────────          ──────────────────
┌─ Node.js/Express ┐      ┌─ React/Vite ───────┐
│  PostgreSQL       │      │  Dashboard UI      │
│  Deepgram STT    │◄────►│  (separate project)│
│  DeepSeek LLM    │ HTTP │  in Lovable       │
│  → :3001/api/*   │      │                    │
└──────────────────┘      └────────────────────┘
        ↕                          ↕
   Render (prod)             Lovable hosting
   Tunnel (dev)
```

## Deployment Notes

- **Local dev:** faster-whisper + ffmpeg audio normalization + DeepSeek
- **Cloud (Render):** Deepgram Nova-3 STT + DeepSeek LLM + PostgreSQL (Supabase)
- Audio files are stored locally under `./audio/` (swap to S3/cloud storage for production)
- CORS is configurable via `CORS_ORIGINS` env var