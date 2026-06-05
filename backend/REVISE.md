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

## Summary: All Files Changed

| File | Type of Change |
|------|---------------|
| `prisma/schema.prisma` | Removed `url` (Prisma 7 migration) |
| `prisma.config.ts` | **NEW** — Prisma 7 config file |
| `src/db.ts` | Rewrote — Prisma 7 adapter pattern |
| `src/config.ts` | Added `vadFilter`, `vadThreshold`, `language` to whisper config |
| `.env` | Updated model to `small`, added VAD + language config |
| `.env.example` | Updated to match `.env` |
| `src/index.ts` | Updated import path (`transcript` → `transcripts`) |
| `src/routes/transcript.ts` | **Renamed** → `src/routes/transcripts.ts` |
| `src/routes/meetings.ts` | `req.params.id` → `String(req.params.id)`, wired real transcription, renamed function call |
| `src/routes/transcripts.ts` | `req.params.id` → `String(req.params.id)` |
| `src/routes/tasks.ts` | `req.params.id` → `String(req.params.id)` |
| `src/services/transcription.ts` | Increased timeout/buffer, language passthrough, better stderr handling |
| `scripts/transcribe.py` | Rewrote — added VAD, language arg, `condition_on_previous_text` |
| `src/services/summarizer.ts` | Renamed function + interface, added empty transcript guard, better markdown output |
| `src/services/llm/deepseek.ts` | Overhauled system prompt — 20 topics, priority enforcement, hallucination guard |
| `src/types/index.ts` | Removed dead code, simplified to API types only |
