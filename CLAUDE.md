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
│   ├── config.ts             # Environment configuration (STT, LLM, audio, JWT)
│   ├── db.ts                 # Prisma client (PostgreSQL with Supabase pooler)
│   ├── types/
│   │   ├── index.ts          # Shared TypeScript types
│   │   └── express.d.ts      # Express Request augmentation (user, workspace)
│   ├── utils/
│   │   └── errors.ts         # AppError class + factory helpers
│   ├── middleware/
│   │   ├── auth.ts           # JWT authentication (requireAuth, optionalAuth)
│   │   ├── workspace.ts      # Workspace membership checks
│   │   └── errorHandler.ts   # Global error handler middleware
│   ├── routes/
│   │   ├── auth.ts           # Register, login, /me endpoints
│   │   ├── workspaces.ts     # Workspace CRUD + member management
│   │   ├── meetings.ts       # Workspace-scoped meetings + share + async processing
│   │   └── legacy-meetings.ts# Backward-compatible flat /api/meetings wrappers
│   └── services/
│       ├── transcription.ts  # STT orchestration — local Whisper or Deepgram cloud + ffmpeg audio normalization
│       ├── summarizer.ts     # Summary generation (LLM)
│       ├── storage/          # Storage provider abstraction (local / Supabase)
│       └── llm/
│           ├── interface.ts  # Provider abstraction interface
│           ├── index.ts      # Provider factory
│           ├── deepseek.ts   # DeepSeek implementation
│           ├── claude.ts     # Future
│           └── openai.ts     # Future
├── scripts/
│   └── transcribe.py         # faster-whisper Python script
├── prisma/
│   ├── schema.prisma         # Models: User, Workspace, WorkspaceMember, SharedMeeting, Meeting, Task
│   └── seed.ts               # Seed script (creates admin user + default workspace)
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
# Set JWT_SECRET (or use the dev default, but always set a strong one in production)

# Generate Prisma client & sync database schema
npx prisma generate
npx prisma db push

# (First-time setup on existing DB) seed default workspace + admin user
npx prisma db seed

# Start dev server
npm run dev
```

## Authentication & Workspace Isolation

All endpoints except `/api/auth/register` and `/api/auth/login` require a JWT token in the `Authorization: Bearer <token>` header. The token is obtained from login/register.

- **Workspace isolation**: Every meeting belongs to a workspace. Users only see meetings in workspaces they're members of.
- **Cross-workspace sharing**: Workspace admins can share meetings with other workspaces (read-only for recipients).
- **Role hierarchy**: `owner` > `admin` > `member`

### Seed Data

Running `npx prisma db seed` creates:
- Admin user: `admin@meeting-assistant.local` / `admin123`
- "Default Workspace" — all existing meetings are assigned here on first run

## API Endpoints

### Auth (`/api/auth`)
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/register` | No | Register `{ email, password, name? }` → user + token + workspaces |
| `POST` | `/login` | No | Login `{ email, password }` → user + token + workspaces |
| `GET` | `/me` | Yes | Current user profile + workspace list |

### Workspaces (`/api/workspaces`)
| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| `GET` | `/` | Member | List user's workspaces |
| `POST` | `/` | — | Create workspace `{ name }` (creator = owner) |
| `GET` | `/:wid` | Member | Get workspace details |
| `PATCH` | `/:wid` | Admin | Update workspace name |
| `DELETE` | `/:wid` | Owner | Delete workspace |
| `GET` | `/:wid/members` | Member | List members |
| `POST` | `/:wid/members` | Admin | Add member by email `{ email, role? }` |
| `PATCH` | `/:wid/members/:uid` | Admin | Change role `{ role }` |
| `DELETE` | `/:wid/members/:uid` | Admin | Remove member |

### Meetings (workspace-scoped, primary API)
**All paths under `/api/workspaces/:wid/meetings`** — requires workspace membership.

| Method | Path | Access | Description |
|--------|------|--------|-------------|
| `GET` | `/` | Member | List owned + shared meetings (`?status=&page=&limit=`) |
| `POST` | `/` | Member | Create meeting `{ title }` |
| `GET` | `/:mid` | Member | Get meeting detail (includes `access: "own" | "shared"`) |
| `PATCH` | `/:mid` | Owner | Update title/duration |
| `DELETE` | `/:mid` | Owner | Delete meeting + audio |
| `POST` | `/:mid/audio` | Owner | Upload audio (multipart, field: `audio`) |
| `GET` | `/:mid/audio` | Member | Download audio |
| `POST` | `/:mid/process` | Owner | Start transcription + summarization |
| `GET` | `/:mid/transcript` | Member | Get transcript text |
| `GET` | `/:mid/summary` | Member | Get structured summary |
| `GET` | `/:mid/tasks` | Member | List tasks |
| `PATCH` | `/:mid/tasks/:tid` | Owner | Update task `{ status, assignee, priority }` |
| `POST` | `/:mid/share` | Admin | Share with workspace `{ targetWorkspaceId }` |
| `DELETE` | `/:mid/share` | Admin | Unshare `?targetWorkspaceId=xxx` |
| `GET` | `/:mid/shared-with` | Owner | List workspaces this meeting is shared with |

### Legacy (backward-compatible)
These require auth and resolve to the user's default workspace. **Deprecated** — use workspace-scoped routes for new code.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/meetings` | List meetings |
| `POST` | `/api/meetings` | Create meeting |
| `GET` | `/api/meetings/:id` | Get meeting |
| `PATCH` | `/api/meetings/:id` | Update meeting |
| `DELETE` | `/api/meetings/:id` | Delete meeting |
| `POST` | `/api/meetings/:id/audio` | Upload audio |
| `GET` | `/api/meetings/:id/audio` | Download audio |
| `POST` | `/api/meetings/:id/process` | Start processing |
| `GET` | `/api/meetings/:id/transcript` | Get transcript |
| `GET` | `/api/meetings/:id/summary` | Get summary |
| `GET` | `/api/meetings/:id/tasks` | List tasks |
| `PATCH` | `/api/tasks/:id` | Update task |

### Health
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health check (no auth required) |

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
| `JWT_SECRET` | Random hex string (run `openssl rand -hex 32`) |

## Architecture

```
Backend (this repo)              Frontend (Lovable)
─────────────────                ──────────────────
┌─ Node.js/Express ┐            ┌─ React/Vite ───────┐
│  PostgreSQL       │            │  Dashboard UI      │
│  (Supabase)       │            │  (separate project)│
│                   │◄──────────►│  in Lovable       │
│  Auth (JWT)       │  HTTP +   │                    │
│  Workspace isolation│ Bearer  │                    │
│  Deepgram STT     │  token    │                    │
│  DeepSeek LLM     │           │                    │
│  → :3001/api/*    │           │                    │
└──────────────────┘            └────────────────────┘
        ↕                                ↕
   Render (prod)                   Lovable hosting
   Tunnel (dev)
```

## Deployment Notes

- **Local dev:** faster-whisper + ffmpeg audio normalization + DeepSeek
- **Cloud (Render):** Deepgram Nova-3 STT + DeepSeek LLM + PostgreSQL (Supabase)
- Audio files are stored locally under `./audio/` (swap to S3/cloud storage for production)
- CORS is configurable via `CORS_ORIGINS` env var