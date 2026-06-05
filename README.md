# Meeting Assistant

A meeting transcription and summarization tool built for marketing teams. Records audio via browser, transcribes with local Whisper, and summarizes with AI (DeepSeek/Claude/OpenAI) into bullet points, tasks, and future prospects.

## Architecture

```
Browser (Lovable Dashboard)
       │
       ▼  REST API
┌─────────────────────┐
│   Node.js Backend   │───→ DeepSeek / Claude / OpenAI API
│   (Express + TS)    │
│                     │───→ faster-whisper (local STT)
│   SQLite DB         │
└─────────────────────┘
```

## Quick Start

```bash
# Backend setup
cd backend
npm install
pip install faster-whisper

# Configure
cp .env.example .env
# Edit .env → set DEEPSEEK_API_KEY=sk-...

# Database
npx prisma generate
npx prisma migrate dev --name init

# Start
npm run dev
```

Server starts at `http://localhost:3001`.

## Dashboard (Lovable)

The frontend dashboard is built in Lovable. See `CLAUDE.md` for the full API contract.

## API Overview

| Endpoint | Description |
|----------|-------------|
| `POST /api/meetings` | Create meeting |
| `GET /api/meetings` | List meetings |
| `GET /api/meetings/:id` | Get meeting details |
| `POST /api/meetings/:id/audio` | Upload audio |
| `POST /api/meetings/:id/process` | Transcribe + summarize |
| `GET /api/meetings/:id/transcript` | Get transcript |
| `GET /api/meetings/:id/summary` | Get summary |
| `GET /api/meetings/:id/tasks` | List tasks |
| `PATCH /api/tasks/:id` | Update task |
