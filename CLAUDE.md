# Meeting Assistant — Marketing Team Transcription & Summarization

## Project Overview

A backend service that records, transcribes, and summarizes marketing team meetings. The frontend dashboard is built in **Lovable** and consumes the REST API here.

**Core flow:** Browser records audio → Upload to API → Local Whisper transcribes → DeepSeek/LLM summarizes → Dashboard displays transcript + bullet points + tasks + future prospects.

## Tech Stack

- **Backend:** Node.js + TypeScript + Express
- **Database:** SQLite via Prisma ORM
- **STT:** faster-whisper (local Python)
- **LLM:** DeepSeek API (OpenAI-compatible), with provider abstraction for Claude/OpenAI swap
- **Frontend:** Lovable (separate project, consumes this API)

## Project Structure

```
backend/
├── src/
│   ├── index.ts              # Express server entry
│   ├── config.ts             # Environment configuration
│   ├── db.ts                 # Prisma client
│   ├── routes/
│   │   ├── meetings.ts       # Meeting CRUD + audio upload + processing
│   │   ├── transcript.ts     # Transcript & summary endpoints
│   │   └── tasks.ts          # Task list & update endpoints
│   └── services/
│       ├── transcription.ts  # Whisper orchestration (Python subprocess)
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

# Install Python dependencies (for transcription)
pip install faster-whisper

# Copy env and set your DeepSeek API key
cp .env.example .env
# Edit .env → set DEEPSEEK_API_KEY=sk-...

# Generate Prisma client & create database
npx prisma generate
npx prisma migrate dev --name init

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

## Deployment Notes

- The backend expects **Python 3** with `faster-whisper` installed on the server
- Audio files are stored locally under `./audio/` (swap to S3/cloud storage for production)
- CORS is configurable via `CORS_ORIGINS` env var
