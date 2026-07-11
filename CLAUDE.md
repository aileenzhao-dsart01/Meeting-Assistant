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
│   ├── config.ts             # Environment configuration (STT, LLM, audio, Supabase Auth)
│   ├── db.ts                 # Prisma client (PostgreSQL with Supabase pooler)
│   ├── types/
│   │   ├── index.ts          # Shared TypeScript types
│   │   └── express.d.ts      # Express Request augmentation (user, workspace)
│   ├── utils/
│   │   └── errors.ts         # AppError class + factory helpers
│   ├── middleware/
│   │   ├── auth.ts           # Supabase JWT verification via JWKS
│   │   ├── workspace.ts      # Workspace membership & role checks
│   │   └── errorHandler.ts   # Global error handler middleware
│   ├── routes/
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
│   ├── schema.prisma         # Models: Workspace, WorkspaceMember, Meeting, Task, MeetingShare
│   └── seed.ts               # Seed script (creates default workspace, assigns orphan meetings)
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
# For Supabase Auth: set SUPABASE_JWKS_URL and SUPABASE_PROJECT_REF
# For Supabase Storage: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY

# Generate Prisma client & sync database schema
npx prisma generate
npx prisma db push

# (First-time setup on existing DB) seed default workspace + assign orphan meetings
npx prisma db seed

# Start dev server
npm run dev
```

## Authentication & Workspace Isolation

**Auth provider: Supabase Auth.** Every API call (except `/api/health`) requires a Supabase JWT in the `Authorization: Bearer <token>` header. The backend verifies the JWT using the project's JWKS endpoint (asymmetric RS256 verification).

### How Auth Works

1. **Frontend handles login** via Supabase Auth (Lovable Cloud / Supabase JS SDK)
2. **JWT is plumbed** as `Authorization: Bearer <access_token>` on every backend request
3. **Backend verifies** the JWT via JWKS — no custom login/register endpoints
4. **Email verification** checked — unverified emails get `403 { error: "email_not_verified" }`
5. **`?token=` fallback** for mobile `<audio>` playback (can't set Auth header on `<audio src>`) — auth middleware checks query param as well

### Key Auth Middleware Details

- **JWKS cache**: Fetched on startup, refreshed every 10 min
- **Clock skew tolerance**: 60 seconds (Render containers can drift)
- **Bearer parsing**: Case-insensitive regex (`/^Bearer\s+(.+)$/i`)
- **Email verified fallback**: If JWT `email_verified` claim is missing, queries `auth.users` via Supabase service role key

### Workspace Isolation

- **Workspace isolation**: Every meeting belongs to a workspace. Users only see meetings in workspaces they're members of.
- **Role hierarchy**: `owner` > `admin` > `member` > `viewer`
  - **owner/admin**: Full CRUD + share on all meetings in workspace
  - **member**: Create meetings, edit/delete own meetings only
  - **viewer**: Read-only access to meetings explicitly shared with them
- **Meeting sharing**: Individual user-level via `MeetingShare` table. Shared meetings appear with `access: "shared"` in the response.
- **Cross-workspace enforcement**: Workspace ID is always from URL params, never from client request body

### Seed Data

Running `npx prisma db seed` creates a "Default Workspace" and assigns any orphan meetings (those with null workspaceId) to it. No admin user is created — auth is entirely through Supabase.

## API Endpoints

### Workspaces (`/api/workspaces`)
All require Supabase JWT auth.

| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| `GET` | `/` | Member | List user's workspaces |
| `POST` | `/` | — | Create workspace `{ name }` (creator = owner) |
| `GET` | `/:wid` | Member | Get workspace details |
| `PATCH` | `/:wid` | Admin | Update workspace name |
| `DELETE` | `/:wid` | Owner | Delete workspace |
| `GET` | `/:wid/members` | Member | List members |
| `POST` | `/:wid/members` | Admin | Add member by Supabase UUID `{ userId, role? }` |
| `PATCH` | `/:wid/members/:userId` | Admin | Change role `{ role }` |
| `DELETE` | `/:wid/members/:userId` | Admin | Remove member |

### Meetings (workspace-scoped, primary API)
All under `/api/workspaces/:wid/meetings` — requires workspace membership.

| Method | Path | Role | Description |
|--------|------|------|-------------|
| `GET` | `/` | Member | List owned + shared meetings (`?status=&page=&limit=`) |
| `POST` | `/` | Member | Create meeting `{ title }` |
| `GET` | `/:mid` | Member | Get meeting detail (includes `access: "own" | "shared"`) |
| `PATCH` | `/:mid` | Own | Update title/duration |
| `DELETE` | `/:mid` | Own | Delete meeting + audio |
| `POST` | `/:mid/audio` | Own | Upload audio (multipart, field: `audio`) |
| `GET` | `/:mid/audio` | Member | Download audio (supports `?token=` query param for mobile) |
| `POST` | `/:mid/process` | Own | Start transcription + summarization |
| `GET` | `/:mid/transcript` | Member | Get transcript text |
| `GET` | `/:mid/summary` | Member | Get structured summary |
| `GET` | `/:mid/tasks` | Member | List tasks |
| `PATCH` | `/:mid/tasks/:tid` | Own | Update task `{ status, assignee, priority }` |
| `POST` | `/:mid/share` | Admin | Share with user `{ userId }` |
| `DELETE` | `/:mid/share/:userId` | Admin | Unshare with user |
| `GET` | `/:mid/shared-with` | Own | List users this meeting is shared with |

### Access Rules (enforced by backend)
| Role | Create | Edit/Delete Own | Edit/Delete Any | Share |
|------|--------|----------------|-----------------|-------|
| owner | ✅ | ✅ | ✅ | ✅ |
| admin | ✅ | ✅ | ✅ | ✅ |
| member | ✅ | ✅ | ❌ | ❌ |
| viewer | ❌ | ❌ | ❌ | ❌ |

Meeting responses include `access: "own"` (editable) or `access: "shared"` (read-only).

### Legacy (backward-compatible)
Require auth, resolve to user's default workspace. **Deprecated.**

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
| `SUPABASE_JWKS_URL` | `https://<project>.supabase.co/auth/v1/.well-known/jwks.json` |
| `SUPABASE_PROJECT_REF` | Supabase project reference ID |
| `SUPABASE_URL` | `https://<project>.supabase.co` (for storage + email-verified fallback) |
| `SUPABASE_SERVICE_ROLE_KEY` | For storage + email-verified fallback (server-only, never expose) |

## Architecture

```
Backend (this repo)                    Frontend (Lovable)
─────────────────                      ──────────────────
┌─ Node.js/Express ┐                  ┌─ React/Vite ───────┐
│  PostgreSQL       │                  │  Dashboard UI      │
│  (Supabase via    │                  │  (separate project)│
│   Prisma)         │                  │  in Lovable       │
│                   │◄────────────────►│                    │
│  Auth: Supabase   │  HTTP + Bearer  │  Auth: Supabase    │
│  JWKS verification│  Supabase JWT   │  JS SDK (login)    │
│  Workspace isolation│               │                    │
│  Deepgram STT     │                  │                    │
│  DeepSeek LLM     │                  │                    │
│  → :3001/api/*    │                  │                    │
└──────────────────┘                  └────────────────────┘
        ↕                                    ↕
   Render (prod)                       Lovable hosting
   Tunnel (dev)                        Supabase Auth UI
```

## Deployment Notes

- **Auth:** Supabase JWT — no custom login/register endpoints. JWKS verification with 60s clock skew tolerance. Email verification enforced.
- **Local dev:** faster-whisper + ffmpeg audio normalization + DeepSeek
- **Cloud (Render):** Deepgram Nova-3 STT + DeepSeek LLM + PostgreSQL (Supabase)
- **Storage:** Audio files stored locally under `./audio/` or in Supabase Storage (configurable via `STORAGE_PROVIDER`)
- **CORS:** Configurable via `CORS_ORIGINS` env var; `.lovable.app` and `.lovableproject.com` wildcard allowed
- **Seed:** Idempotent — creates Default Workspace and assigns orphan meetings on first run