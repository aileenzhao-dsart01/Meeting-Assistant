# Revision Log — Meeting Assistant Backend

All modifications made on **2026-06-05**, organized by category.

## Background / User Requirements

These revisions were driven by the following real-world usage concerns:

> **1. Long meetings (45 min – 1 hour):** "The meeting we are having are at least 45 minute to 1 hour, we need it performing consistently for long meeting."
>
> **2. Far-field / large room recording:** "We might sit in a large room multiple talkers, and it should have a better listening even the device place in distance."
>
> **3. Accented speech:** "How to control accent management?"
>
> **4. Topic scope expansion:** "Also add web development and IT call tracking security cyber."
>
> **5. Summary quality:** "Is there anyway to have better logic in summary and all the topics are about marketing and sales."
>
> **6. Naming conventions:** "Need to have the common sense to write them right."

---

## 1. Infrastructure & Database Setup

### 1.1 Prisma 7 Migration

The project was originally written for Prisma 6 but installed with Prisma 7, which has a breaking change: `datasource.url` in `schema.prisma` is no longer supported.

**Changes:**

| File | Before | After |
|------|--------|-------|
| `prisma/schema.prisma` | `url = "file:./dev.db"` | Removed `url` — moved to config file |
| `prisma.config.ts` | ❌ Did not exist | **Created** — new Prisma 7 config file with `defineConfig()` |
| `src/db.ts` | `new PrismaClient()` | `new PrismaClient({ adapter })` using `@prisma/adapter-libsql` |

**What it fixed:** Prisma 7 requires datasource configuration to be in `prisma.config.ts` and uses adapters for database connections. This was blocking `prisma generate` and `prisma db push`.

### 1.2 TypeScript Route Fixes

Express 5 changed `req.params` types — `req.params.id` is `string | string[]` instead of `string`.

**Files changed:** `src/routes/meetings.ts`, `src/routes/transcripts.ts` (renamed), `src/routes/tasks.ts`

| Before | After |
|--------|-------|
| `req.params.id` | `String(req.params.id)` |

**What it fixed:** TypeScript strict mode errors across all route files.

---

## 2. Naming Convention Fixes

> **User requirement:** "For name convention on the software, need to have the common sense to write them right."

### 2.1 Naming Audit

Inconsistent naming patterns identified and corrected across the codebase.

### 2.2 Changes

| Location | Before | After | Reason |
|----------|--------|-------|--------|
| `src/routes/transcript.ts` | `transcript.ts` | `transcripts.ts` | Plural consistency with `meetings.ts`, `tasks.ts` |
| `src/index.ts` import | `./routes/transcript` | `./routes/transcripts` | Matches renamed file |
| `src/services/summarizer.ts` — function | `meetingSummary()` | `summarizeMeeting()` | Verbs should be function names, nouns for data |
| `src/services/summarizer.ts` — interface | `SummaryResult` | `SummarizedMeeting` | Describes *what* the object represents |
| `src/routes/meetings.ts` — import | `meetingSummary` | `summarizeMeeting` | Matches renamed function |
| `src/types/index.ts` | Duplicate `MeetingSummary` + `TaskItem` interfaces | Removed dead code, simplified to API types only | Nothing imported these — they conflicted with `llm/interface.ts` |

---

## 3. Transcription Pipeline — Real Implementation

### 3.1 Placeholder Transcript

The processing pipeline was using a dummy placeholder instead of actually calling Whisper.

**File:** `src/routes/meetings.ts` (line 245)

| Before | After |
|--------|-------|
| `const transcript = \`[Transcription placeholder — will be replaced by faster-whisper in Phase 3. Audio file: ...]\`;` | `const { transcribeAudio } = await import("../services/transcription");`<br>`const transcript = await transcribeAudio(audioPath);` |

**What it fixed:** The pipeline now actually transcribes audio instead of returning a placeholder string.

### 3.2 Empty Transcript Guard

**File:** `src/services/summarizer.ts`

| Before | After |
|--------|-------|
| No check — passed empty text to LLM | `if (!transcript \|\| transcript.trim().length < 20) throw new Error(...)` |

**What it fixed:** Prevents DeepSeek from hallucinating fake marketing data when given an empty or near-empty transcript. The system returns a clear error instead.

---

## 4. Long Meeting Support (45-60 min)

> **User requirement:** "The meeting we are having are at least 45 minute to 1 hour, we need it performing consistently for long meeting."

### 4.1 Whisper Model Upgrade

**File:** `.env`

| Before | After |
|--------|-------|
| `WHISPER_MODEL_SIZE=base` | `WHISPER_MODEL_SIZE=small` |

`small` provides significantly better accuracy for long meetings with distant mics, at a modest speed cost (~2x slower than `base` but still real-time for 45-min meetings).

### 4.2 Timeout & Buffer Increases

**File:** `src/services/transcription.ts`

| Parameter | Before | After |
|-----------|--------|-------|
| Timeout | `30 * 60 * 1000` (30 min) | `120 * 60 * 1000` (2 hours) |
| Output buffer | `10 * 1024 * 1024` (10 MB) | `50 * 1024 * 1024` (50 MB) |
| stderr error handling | Always rejected on stderr | Only rejects if stdout is empty (VAD logs to stderr) |

### 4.3 Context Tracking

**File:** `scripts/transcribe.py`

| Before | After |
|--------|-------|
| `model.transcribe(...)` without `condition_on_previous_text` | `condition_on_previous_text=True` added |

Long meetings lose context over time — this flag tells Whisper to use previous text as a reference for later segments, which improves consistency across 45-60 minute recordings.

---

## 5. Far-Field / Multi-Talker Optimization

> **User requirement:** "We might sit in a large room multiple talkers, and it should have a better listening even the device place in distance."

### 5.1 VAD (Voice Activity Detection)

**File:** `scripts/transcribe.py` — completely rewrote the transcription function.

| Feature | Before | After |
|---------|--------|-------|
| VAD filter | ❌ Not used | `vad_filter=True` |
| VAD threshold | N/A | `0.4` (more sensitive than default 0.5 — catches distant speakers) |
| Min speech duration | N/A | `200ms` (ignores coughs, door clicks) |
| Min silence duration | N/A | `500ms` (keeps speaker turns together) |
| Speech padding | N/A | `300ms` (don't cut off word beginnings/endings) |
| Max speech segment | N/A | `30s` (resets context for long recordings) |
| Language argument | Only `model_size` passed | `model_size` + `language` both passed from Node.js |

**How VAD helps:**
- Filters out room noise and silence **before** Whisper processes audio
- Critical for far-field mics (laptop built-in, room microphone)
- Speeds up processing of long meetings by skipping non-speech segments
- Multiple speakers talking over each other — VAD isolates speech segments

### 5.2 Config-Driven VAD Settings

**File:** `src/config.ts`

| Before | After |
|--------|-------|
| `whisper: { modelSize, language }` | `whisper: { modelSize, language, vadFilter, vadThreshold }` |

**File:** `.env` — added VAD configuration options:

```
WHISPER_VAD_FILTER=true
WHISPER_VAD_THRESHOLD=0.4
```

---

## 6. LLM Prompt Improvements

> **User requirement:** "Is there anyway to have better logic in summary and all the topics are about marketing and sales."
> **Follow-up:** "Also add web development and IT call tracking security cyber."

### 6.1 System Prompt Overhaul

**File:** `src/services/llm/deepseek.ts` — `SYSTEM_PROMPT`

| Aspect | Before | After |
|--------|--------|-------|
| Role description | "marketing team meeting assistant" | "meeting assistant for a business that covers marketing, sales, web development, IT, and cybersecurity" |
| Topic scope | 11 marketing-only topics | **20 topics** — added Web Development, IT/Infrastructure, Call Tracking, Security & Cyber |
| Off-topic handling | Not specified — would hallucinate | Returns clean "not about recognized business topic" response |
| Priority requirement | Optional — often missing | **ALWAYS required** (high/medium/low) |
| Metrics extraction | Not mentioned | Explicitly instructed: percentages, dollar amounts, dates, version numbers, ticket IDs |
| Assignee extraction | Not mentioned | Explicitly instructed |
| Task count requirement | Not mentioned | Never leave priority blank |

### 6.2 New Topics Added

- Web Development
- IT / Infrastructure
- Call Tracking
- Security & Cyber

---

## 7. Summary Output Formatting

> **User requirement:** "Is there anyway to have better logic in summary and all the topics are about marketing and sales."

**File:** `src/services/summarizer.ts`

| Aspect | Before | After |
|--------|--------|-------|
| Header | `## Summary` | `# {Meeting Title}` (dynamic) |
| Section title | Flat list | `## Key Discussion Points` |
| Tasks | `- [ ] description [priority]` | `- [ ] description — @assignee 🔴/🟡/🟢` with visual priority emojis |
| Prospects | `### Future Prospects` | Separated section, only if non-empty |
| Topics | `*Topics: ...*` | `---` divider with ` · ` separated topics |
| Empty sections | Always rendered | Collapsed if no data ("Action Items" / Prospects section only shown when content exists) |
| Non-marketing meetings | Would hallucinate | Returns: "Meeting was not related to a recognized business topic." |

**Example output comparison:**

**Before:**
```
## Summary

- Email campaign had 22% open rate
- PPC campaign on track
...
*Topics: email marketing, PPC, SEO*
```

**After:**
```
# Marketing Weekly - Week 24

## Key Discussion Points

- Email campaign open rate 25%, up 3% from last month.
- PPC spend $15,000, cost per lead $42.
...

## Action Items

- [ ] Send webinar reminder email by Tuesday. 🔴

## Future Prospects

- Webinar next Thursday with 150 registrations.

---
*Topics: Email Marketing · PPC / Paid Search · SEO / Organic · Webinar & Events*
```

---

## 8. Accent Management

> **User requirement:** "How to control accent management?"

### 8.1 Language Configuration

**File:** `scripts/transcribe.py`

| Before | After |
|--------|-------|
| `model.transcribe(audio_path, beam_size=5)` | `model.transcribe(audio_path, beam_size=5, language="en")` |

Fixing the language tells Whisper exactly what to expect, which significantly improves recognition for accented English. Without it, Whisper spends inference time guessing the language first.

**File:** `.env` — `WHISPER_LANGUAGE=en` with documentation:
- Set to specific ISO 639-1 code (`en`, `zh`, `ja`, `fr`, `de`, `es`) for best accent accuracy
- Set to `auto` for multi-language meetings (slightly less accurate per language)

---

## 9. Lovable Compatibility Gap Fixes

> **Requirement:** Lovable UI checklist — CORS, idempotency, serialization, content-types, concurrency.

### 9.1 CORS

**File:** `src/index.ts`

| Before | After |
|--------|-------|
| Static origin list with exact matches | Function-based origin: allows configured origins + any `*.lovableproject.com` URL |
| Methods: `GET, POST, PATCH, DELETE` | Added `OPTIONS` (required for CORS preflight) |
| `express.json()` with no limit | `express.json({ limit: "1mb" })` |

### 9.2 Process Idempotency

**File:** `src/routes/meetings.ts`

| Before | After |
|--------|-------|
| Always started processing | Checks `status` — if already `transcribing` or `summarizing`, returns `202 { message: "Already processing" }` |
| Always returned `200` | Returns `202 Accepted` |
| No error reset | Clears `error` field when re-processing a failed meeting |

### 9.3 Date Serialization

**File:** `src/routes/meetings.ts` (Create endpoint)

| Before | After |
|--------|-------|
| `res.json({ success: true, data: meeting })` (raw Prisma object with Date) | `date.toISOString()`, `createdAt.toISOString()`, `updatedAt.toISOString()` |

### 9.4 Audio Download Content-Type

**File:** `src/routes/meetings.ts` (Download endpoint)

| Before | After |
|--------|-------|
| `res.sendFile(audioPath)` — no Content-Type header | Sets `Content-Type` based on file extension (`.wav` → `audio/wav`, `.mp3` → `audio/mpeg`, `.webm` → `audio/webm`, etc.) |

### 9.5 Whisper Concurrency

**File:** `src/services/transcription.ts`

| Before | After |
|--------|-------|
| Every `/process` call could spawn a Python subprocess | **Semaphore** — only 1 transcription runs at a time; subsequent calls queue and run sequentially |
| No queue mechanism | `enqueueTranscription()` with FIFO queue and `runQueued()` dequeuer |

This prevents OOM when multiple long meetings are submitted simultaneously.

---

## Summary: All Files Changed

| File | Type of Change |
|------|---------------|
| `prisma/schema.prisma` | Removed `url` (Prisma 7 migration) |
| `prisma.config.ts` | **NEW** — Prisma 7 config file |
| `src/db.ts` | Rewrote — Prisma 7 adapter pattern |
| `src/config.ts` | Added `vadFilter`, `vadThreshold`, `language` to whisper config |
| `.env` | Updated model to `small`, added VAD + language config |
| `.env.example` | Updated to match `.env` |
| `src/index.ts` | Updated import path, CORS function-based origin, OPTIONS method, express.json limit |
| `src/routes/transcript.ts` | **Renamed** → `src/routes/transcripts.ts` |
| `src/routes/meetings.ts` | `String(req.params.id)`, wired real transcription, renamed function, idempotent /process, 202 status, date serialization, audio Content-Type |
| `src/routes/transcripts.ts` | `String(req.params.id)` |
| `src/routes/tasks.ts` | `String(req.params.id)` |
| `src/services/transcription.ts` | Timeout/buffer, language passthrough, semaphore-based concurrency bounding |
| `scripts/transcribe.py` | Rewrote — added VAD, language arg, `condition_on_previous_text` |
| `src/services/summarizer.ts` | Renamed function + interface, empty transcript guard, structured markdown output |
| `src/services/llm/deepseek.ts` | Overhauled system prompt — 20 topics, priority enforcement, hallucination guard |
| `src/types/index.ts` | Removed dead code, simplified to API types only |
| `CLAUDE.md` | Updated transcript.ts → transcripts.ts reference |
| `REVISE.md` | **NEW** — this file |
| `LOVABLE_PROMPT.md` | **NEW** — prompt for Lovable UI generation |

---

# Recent Changes — Large Files, Streaming & Resilience (2026-07 → 2026-08)

These revisions were driven by real-world production failures on Render free tier
(512MB RAM, no ffmpeg, ephemeral disk, cold starts) once meetings grew past ~30 minutes.

> **Problem:** "While I was using the meeting transcript there is one error occurred for a 34 minutes longer meeting as failed to upload Supabase Storage upload failed 400 statuscode 413 error Payload too large."
> **Then:** "during the daytime, I noticed a backend failure… Now looks good in rendering."

Each failure was traced to a specific root cause and fixed. The overarching goal became
**stream audio end-to-end (no full-file Buffers in RAM)** and **survive crashes, restarts, and provider blips**.

---

## 1. Email Delivery — SMTP → SendGrid REST API

> **Why:** Render free tier blocks outbound port 587, breaking SMTP-based invite emails.

**File:** `src/services/email/` (SendGrid implementation replacing nodemailer SMTP)

| Before | After |
|--------|-------|
| Nodemailer via SMTP (`host`/`port`/`user`/`pass`) | SendGrid REST API over HTTPS (`SENDGRID_API_KEY`) |
| Port 587 — **blocked** on Render free | HTTPS 443 — works on Render free |

**What it fixed:** Workspace invite emails now send from Render's free tier.

---

## 2. Supabase Storage — Large Upload Fixes (413 → OOM → streaming)

### 2.1 The original 413 (Payload Too Large)

> **Failure:** `Supabase Storage upload failed 400 statuscode 413 error Payload too large` on a 34-min meeting.

**File:** `src/services/storage/supabase.ts` — `save()`

| Before | After |
|--------|-------|
| Raw `fetch()` POST to `…/storage/v1/object/{bucket}/{file}` with the whole file as the body | `@supabase/supabase-js` SDK `storage.from(bucket).upload()` |

**What it fixed:** The raw REST POST went through Supabase's API gateway (Cloudflare),
which caps request bodies at ~10MB. The SDK uses a higher-level upload path.

### 2.2 In-memory copies → file-path based save

**File:** `src/services/storage/interface.ts`, `src/services/storage/local.ts`, `src/services/storage/supabase.ts`

| Before | After |
|--------|-------|
| `save(filename, data: Buffer, mimeType)` — caller read the whole file into RAM | `save(filename, filePath, mimeType)` — provider streams from disk |
| Local: `fs.writeFileSync(fp, data)` | Local: `fs.copyFileSync(filePath, fp)` |
| Supabase: `openAsBlob(filePath)` fed to SDK | Supabase: `fs.createReadStream(filePath).pipe(req)` via raw `http/https` |

### 2.3 The SDK's FormData OOM (the subtle one)

> **Failure:** uploading a ~300MB file spiked memory by **+302MB**, OOM-killing the 512MB instance mid-upload
> ("Cannot reach backend" then a restart). The SDK wraps Blobs in `FormData`, and undici buffers the **entire**
> FormData in RAM even for a file-backed Blob.

**File:** `src/services/storage/supabase.ts` — removed the `@supabase/supabase-js` dependency from this provider entirely.

| Before | After |
|--------|-------|
| SDK `upload()` → FormData → undici buffers whole body (+302MB/300MB) | Raw `http`/`https` request, `fs.createReadStream().pipe(req)` (**+68MB**/300MB) |
| `supabase-js` imported | No SDK — direct REST with `Authorization` + `x-upsert: true` |

**What it fixed:** Streaming to Supabase keeps RAM flat regardless of file size.

### 2.4 `exists()` was downloading the whole file

> **Failure:** clicking **Process** OOM-killed the server a few seconds in. The process route called
> `storage.exists()`, which was implemented as `read()` — fetching and buffering the entire audio just to check it exists.

**File:** `src/services/storage/supabase.ts`

| Before | After |
|--------|-------|
| `exists()` → `read()` → full download → `Buffer` | `exists()` sends `Range: bytes=0-0` and checks the status (404 = missing, 200/206/416 = present) |

---

## 3. Upload & Processing Limits

**Files:** `src/routes/meetings.ts`, `src/routes/legacy-meetings.ts`, `src/services/transcription.ts`

| Limit | Before | After |
|-------|--------|-------|
| Multer upload `fileSize` | 200MB → 500MB | **2GB** |
| Local whisper stdout `maxBuffer` | 50MB | **200MB** |

---

## 4. Transcription — Deepgram 5-minute timeout

> **Failure:** meetings > ~60 min failed during transcription.

**File:** `src/services/transcription.ts` — added `requestLongTimeout()` helper

| Before | After |
|--------|-------|
| Global `fetch()` (undici) to Deepgram — **aborts after 5 min** with no response headers | Raw `http`/`https` request with **2-hour idle timeout** |
| Long files queued by Deepgram exceed 5 min → request dies | Request stays open while Deepgram processes |

---

## 5. Streaming Audio End-to-End (2-hour meetings)

> **Goal:** make 2-hour meetings consistently succeed on Render's 512MB instance.

**Files:** `src/services/storage/interface.ts`, `supabase.ts`, `local.ts`, `src/services/transcription.ts`,
`src/routes/meetings.ts`, `src/routes/legacy-meetings.ts`, `src/index.ts`

### 5.1 `StorageProvider.readStream()`

| Before | After |
|--------|-------|
| `read()` → full `Buffer` | `readStream(key, signal?)` → `{ stream, size }` — streams ONE stored object |
| Supabase: `fetch` + `arrayBuffer` | Supabase: `fetch` + `Readable.fromWeb(res.body)` (abortable) |
| Local: `fs.readFileSync` | Local: `fs.createReadStream` |

### 5.2 Download for processing

**File:** `src/routes/meetings.ts` — `processMeeting`

| Before | After |
|--------|-------|
| `storage.read()` → full Buffer → `fs.writeFileSync` | `storage.readStream()` → `pipe` to disk via `fs.createWriteStream` |

### 5.3 Deepgram body streamed

**File:** `src/services/transcription.ts` — `transcribeDeepgram`

| Before | After |
|--------|-------|
| `fs.readFileSync(audioToSend)` → whole Buffer as body | `fs.createReadStream(audioToSend)` as body |
| `Content-Type` hardcoded `audio/wav` | `Content-Type` from actual extension via `getMimeType()` |

### 5.4 Save the ORIGINAL upload (not a WAV)

> **Fix:** the upload handler used to run `normalizeAudio` (ffmpeg → WAV, 10–20× larger) and rename to `.wav`.
> On Render there's no ffmpeg, so webm/opus bytes were being stored as `*.wav` and **mislabeled** `audio/wav` — a latent
> playback/transcription bug. Now the original compressed file is stored with its correct extension.

### 5.5 Playback streams to the client

| Before | After |
|--------|-------|
| `storage.read()` + `res.send(buffer)` | `readStream` → `pipe(res)`, `Content-Length` set, abort on client disconnect |

### 5.6 Crash recovery on boot

**File:** `src/index.ts` — `recoverInterruptedMeetings()`

| Before | After |
|--------|-------|
| Crash mid-processing → meeting stuck in `transcribing` forever | On boot: stuck `transcribing`/`summarizing` → `status:"error"` ("please re-run"); stuck `uploading` → `pending` |

---

## 6. Server Crash on Client Disconnect (the streaming gotcha)

> **Failure:** a client disconnecting mid-stream (e.g. the frontend tearing down the audio player when processing starts)
> triggered `res.on("close") → abort()`, which surfaced an `AbortError` on the source `Readable`. With no `'error'`
> listener, that **unhandled error crashed the entire process** — "Cannot reach backend" then restart.

**Files:** `src/routes/meetings.ts`, `src/routes/legacy-meetings.ts`, `src/services/storage/supabase.ts`

| Before | After |
|--------|-------|
| `res.on("close") → abort.abort()` unconditionally | Guard with `if (!res.writableEnded) abort.abort()` |
| No `'error'` listener on the streamed `Readable` | No-op `'error'` listener — a disconnect is expected, swallow it |
| 500 catch wrote to a closed response | Guarded with `if (!res.headersSent && !res.writableEnded)` |
| Supabase `save()` file stream had no error handler | `fileStream.on("error", (e) => req.destroy(e))` |

---

## 7. Backend Resilience Hardening

> **Goal:** survive crashes, restarts, and provider blips without the "went down during the day, came back later"
> pattern that plagues free tier.

**Files:** `src/index.ts`, `src/services/processQueue.ts` (**NEW**), `src/utils/retry.ts` (**NEW**),
`src/routes/meetings.ts`, `src/routes/legacy-meetings.ts`, `src/services/transcription.ts`,
`src/services/llm/deepseek.ts`, `src/services/storage/supabase.ts`

### 7.1 Process-level crash protection

**File:** `src/index.ts`

| Before | After |
|--------|-------|
| No handler — one unhandled rejection/exception killed the whole process (30–60s cold start) | `process.on("uncaughtException" / "unhandledRejection")` — log loudly, keep serving |

### 7.2 Graceful shutdown

| Before | After |
|--------|-------|
| SIGTERM (deploy/restart) cut in-flight jobs mid-transcription | SIGTERM/SIGINT handler: stop accepting → drain in-flight → close DB pool → exit (15s force-exit fallback) |

### 7.3 Startup DB retry + real health check

| Before | After |
|--------|-------|
| Single `prisma.$connect()`, `exit(1)` on a transient Supabase blip → server stays down | `connectWithRetry()` — exponential backoff (5 attempts) |
| `/api/health` returned `ok` always | `/api/health` pings the DB (`SELECT 1`); returns `503 db_unreachable` on failure |

### 7.4 Concurrency + no double-processing

**File:** `src/services/processQueue.ts` (**NEW**)

| Before | After |
|--------|-------|
| `processMeeting` unbounded — N concurrent jobs stacked ffmpeg + Deepgram + LLM → OOM on 512MB | `runWithConcurrencyLimit()` — `MAX_CONCURRENT = 1`, jobs serialize, rest queue |
| Status check was read-then-act (two requests could both pass and double-process → double Deepgram/LLM spend) | **Atomic claim** via `prisma.meeting.updateMany({ where: { id, status: { notIn: [transcribing, summarizing] } }, data: { status: "transcribing" } })` — the DB decides who wins |

### 7.5 Temp file cleanup on upload error

| Before | After |
|--------|-------|
| If `storage.save` threw, `.upload-tmp` leaked on Render's ephemeral disk | `catch` block unlinks `req.file.path` |

### 7.6 Retry on transient provider errors

**File:** `src/utils/retry.ts` (**NEW**) — `withRetry()` with exponential backoff on 5xx/429/network errors.

| Provider | Before | After |
|----------|--------|-------|
| Deepgram | No retry — one 5xx marked the meeting `error` | Retries 3× (`maxRetries: 3`, `baseDelayMs: 1500`); WAV temp cleanup in `finally` survives attempts |
| DeepSeek/LLM | SDK default `maxRetries=2`, 10-min default | `maxRetries: 3`, explicit `timeout: 10 * 60 * 1000` |
| Supabase storage | No retry on `save`/`read`/`delete`/`exists` | `withRetry` wrapped on all four (3×, backoff) |

### 7.7 Async ffmpeg (no event-loop freeze)

> **Why:** `execSync` ffmpeg passes (up to 600s) blocked the **entire event loop** — every request including
> `/api/health` hung while normalizing audio, so the backend "looked down" during every long meeting.

**File:** `src/services/transcription.ts`

| Before | After |
|--------|-------|
| `execSync(\`${FFMPEG_PATH} -i … -af …\`)` in `analyzeVolume`, `normalizeAudio` passes, and Deepgram WAV conversion | `runFfmpeg(args, timeoutMs)` — async `execFile`, non-blocking |
| Event loop frozen for the duration of each ffmpeg pass | Server stays responsive during processing |

---

## Summary: All Files Changed (recent work)

| File | Type of Change |
|------|---------------|
| `src/services/storage/supabase.ts` | Streaming save (no SDK/FormData), `readStream`, `exists()` via Range, retries, stream error guards |
| `src/services/storage/interface.ts` | Added `StoredStream` + `readStream(key, signal?)` |
| `src/services/storage/local.ts` | `readStream` via `fs.createReadStream`, `copyFileSync` save |
| `src/services/transcription.ts` | `requestLongTimeout` (2h), streamed Deepgram body, async `runFfmpeg`, Deepgram retry, `normalizeAudio` async |
| `src/routes/meetings.ts` | Streaming playback/process, save original upload, atomic process claim, concurrency cap, temp cleanup, crash-safe streams |
| `src/routes/legacy-meetings.ts` | Mirrors all meeting.ts changes |
| `src/index.ts` | Crash handlers, graceful shutdown, DB retry, real health check, crash recovery |
| `src/services/processQueue.ts` | **NEW** — `runWithConcurrencyLimit` (MAX_CONCURRENT=1) |
| `src/utils/retry.ts` | **NEW** — `withRetry` exponential backoff |
| `src/services/llm/deepseek.ts` | `maxRetries: 3`, 10-min timeout |
| `src/services/email/` | **NEW** — SendGrid REST delivery (replaces SMTP) |

