# Meeting Assistant

A meeting transcription and summarization tool built for marketing teams. Records audio via browser, transcribes via **Deepgram Nova-3** (cloud) or **faster-whisper** (local), enhances audio with **ffmpeg speech frequency filtering**, and summarizes with **DeepSeek** into bullet points, tasks, topics, and future prospects.

## Architecture

```
Frontend (Lovable)                   Backend (Node.js + Express)
────────────────────                  ──────────────────────────────
                                      ┌─────────────────────────┐
                                      │  Audio Upload           │
                                      │    ↓                    │
                                      │  Supabase Storage       │── Audio persists
                                      │    ↓                    │   across restarts
                                      │  ffmpeg Enhancement     │
                                      │  (speech band-pass)     │
                                      │    ↓                    │
                                      │  Deepgram Nova-3 (STT)  │── Cloud API
                                      │  or faster-whisper      │
                                      │    ↓                    │
                                      │  DeepSeek (LLM)         │── Cloud API
                                      │  (summarization +       │
                                      │   logic completion)     │
                                      │    ↓                    │
                                      │  PostgreSQL (Supabase)  │── Prisma ORM
                                      └─────────────────────────┘

           ↕                                    ↕
    Lovable hosting                      Render (production)
                                        Cloudflare Tunnel (dev)
```

## Tech Stack

| Layer | Local Dev | Production (Render) |
|-------|-----------|-------------------|
| **Runtime** | Node.js + tsx watch | Node.js (compiled) |
| **Database** | Supabase PostgreSQL | Supabase PostgreSQL |
| **Audio Storage** | Local disk (`./audio/`) | Supabase Storage (persistent) |
| **STT** | faster-whisper (Python) | Deepgram Nova-3 (cloud) |
| **Audio Enhancement** | ffmpeg speech band-pass | Skipped (no ffmpeg) |
| **LLM** | DeepSeek API | DeepSeek API |
| **Frontend** | Lovable (separate project) | Lovable hosting |

## Folder Structure

```
backend/
├── src/
│   ├── index.ts              # Express server + CORS + routes
│   ├── config.ts             # Environment configuration
│   ├── db.ts                 # Prisma client (Supabase PostgreSQL)
│   ├── routes/
│   │   ├── meetings.ts       # CRUD + audio upload + processing pipeline
│   │   ├── transcripts.ts    # Transcript & summary endpoints
│   │   └── tasks.ts          # Task list & update endpoints
│   └── services/
│       ├── transcription.ts  # STT (Deepgram cloud / local Whisper) + ffmpeg audio enhancement
│       ├── summarizer.ts     # Summary generation (LLM)
│       ├── storage/          # File storage abstraction
│       │   ├── interface.ts  # StorageProvider contract
│       │   ├── local.ts      # Local disk implementation
│       │   ├── supabase.ts   # Supabase Storage implementation
│       │   └── index.ts      # Factory
│       └── llm/
│           ├── interface.ts  # LLM provider abstraction
│           ├── deepseek.ts   # DeepSeek implementation
│           ├── claude.ts     # Future
│           └── openai.ts     # Future
├── scripts/
│   └── transcribe.py         # faster-whisper Python script
├── prisma/
│   └── schema.prisma
├── audio/                    # Local audio storage (gitignored)
├── render.yaml               # Render deployment config
└── package.json
```

## Quick Start

```bash
cd backend

# Install Node.js dependencies
npm install

# Install ffmpeg (for audio enhancement, recommended)
brew install ffmpeg

# Install Python deps (for local whisper, optional)
pip install faster-whisper

# Configure
cp .env.example .env
# Edit .env → set at minimum:
#   DEEPSEEK_API_KEY=sk-...
#   DATABASE_URL=postgresql://...

# Generate Prisma client & sync database schema
npx prisma generate
npx prisma db push

# Start dev server
npm run dev
```

Server starts at `http://localhost:3001`.

## Configuration

### Speech-to-Text

| Env Var | Values | Default | Description |
|---------|--------|---------|-------------|
| `STT_PROVIDER` | `local` / `deepgram` | `local` | Use faster-whisper or Deepgram Nova-3 |
| `DEEPGRAM_API_KEY` | string | — | Deepgram key (free at deepgram.com, $200 credit) |
| `DEEPGRAM_KEYWORDS` | comma-separated | — | Boost names/jargon: `"Ran Zhao:5,PPC:3"` |
| `DEEPGRAM_FILTER_FILLER` | `true` / `false` | `true` | Strip "um, uh, like" from transcript |

### Audio Enhancement (ffmpeg)

| Env Var | Values | Default | Description |
|---------|--------|---------|-------------|
| `AUDIO_NORMALIZE` | `true` / `false` | `true` | Enable pre-processing pipeline |
| `AUDIO_CLARITY_MODE` | `basic` / `speech` / `max` | `speech` | Enhancement level |
| `AUDIO_TARGET_LOUDNESS` | number (LUFS) | `-14` | Target loudness |

**Clarity modes:**
- `basic` — high-pass filter + volume gain
- `speech` — band-pass 200-4500Hz + speech EQ (recommended)
- `max` — speech + compression (very uneven volume)

### Storage

| Env Var | Values | Default | Description |
|---------|--------|---------|-------------|
| `STORAGE_PROVIDER` | `local` / `supabase` | `local` | Where audio files are stored |
| `SUPABASE_URL` | URL | — | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | string | — | Service role key (not anon) |
| `SUPABASE_STORAGE_BUCKET` | string | `meeting-audio` | Bucket name (must be public) |

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/meetings` | List meetings (`?status=complete&page=1&limit=20`) |
| `POST` | `/api/meetings` | Create meeting `{ title: string }` |
| `GET` | `/api/meetings/:id` | Get meeting with transcript, summary & tasks |
| `PATCH` | `/api/meetings/:id` | Rename meeting |
| `DELETE` | `/api/meetings/:id` | Delete meeting + audio |
| `POST` | `/api/meetings/:id/audio` | Upload audio (multipart, field: `audio`, max 200MB) |
| `GET` | `/api/meetings/:id/audio` | Download audio |
| `POST` | `/api/meetings/:id/process` | Start async transcription + summarization |
| `GET` | `/api/meetings/:id/transcript` | Get transcript text |
| `GET` | `/api/meetings/:id/summary` | Get structured summary |
| `GET` | `/api/meetings/:id/tasks` | List tasks for a meeting |
| `PATCH` | `/api/tasks/:id` | Update task `{ status: "done" }` |

All responses follow:
```json
{ "success": true, "data": ... }
{ "success": false, "error": "human-readable message" }
```

## Processing Flow

```
1. POST /api/meetings              → create meeting
2. POST /api/meetings/:id/audio    → upload recording (multipart)
3. POST /api/meetings/:id/process  → start async pipeline
4. GET /api/meetings/:id           → poll until status === "complete"

Status progression:
  pending → uploading → transcribing → summarizing → complete
                                                    ↘ error
```

The transcript includes **speaker labels** (`Speaker 0:`, `Speaker 1:`) with consecutive same-speaker utterances grouped into paragraphs. The LLM applies **logic completion** to reconstruct full sentences from fragmented speech.

## Deployment (Render)

The project includes `render.yaml` for one-click deploy on [Render](https://render.com) free tier.

**Limitations on Render free tier:**
- ❌ No Python — uses Deepgram for STT instead
- ❌ No ffmpeg — audio enhancement skipped (Deepgram handles noise)
- ✅ Audio persists via Supabase Storage
- ✅ All API endpoints work

**Required env vars on Render:**
| Key | Value |
|-----|-------|
| `DATABASE_URL` | Supabase connection string |
| `DEEPSEEK_API_KEY` | From DeepSeek dashboard |
| `DEEPGRAM_API_KEY` | From deepgram.com (free $200 credit) |
| `STT_PROVIDER` | `deepgram` |
| `STORAGE_PROVIDER` | `supabase` |
| `SUPABASE_URL` | Supabase dashboard → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → Settings → API |
| `CORS_ORIGINS` | Your Lovable frontend URL |

## Adding an LLM Provider

1. Create `src/services/llm/<name>.ts` implementing `LLMProvider` interface
2. Add case in `src/services/llm/index.ts` factory
3. Add config keys in `src/config.ts` and `.env`

## Reference

- [PAID_SERVICES.md](PAID_SERVICES.md) — All third-party services and pricing
- [CHANGE_REMINDER.md](CHANGE_REMINDER.md) — What backend changes need frontend updates
- [CLAUDE.md](CLAUDE.md) — Detailed API contract and project info (for AI assistants)
