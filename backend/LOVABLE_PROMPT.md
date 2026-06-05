# Lovable UI Prompt

Copy and paste the following into Lovable when creating a new project.

---

```
Build a meeting assistant dashboard for marketing, sales, IT, and security teams.

## API Base URL
http://localhost:3001

All responses follow this exact envelope:
- Success: { "success": true, "data": ... }
- Error:   { "success": false, "error": "human-readable message" }

Errors are always JSON — never HTML. Read json.error on failure.

## API Endpoints

### Meetings
- GET  /api/meetings — list (?status=complete&page=1&limit=20) — newest first
- POST /api/meetings — create { "title": "string" } → returns full meeting
- GET  /api/meetings/:id — full detail with transcript, summary, bulletPoints[], topics[], tasks[], duration
- DELETE /api/meetings/:id — deletes meeting + audio file
- POST /api/meetings/:id/audio — upload audio (multipart/form-data, field name: "audio") → 200MB max
- GET  /api/meetings/:id/audio — download original audio file (proper Content-Type header)
- POST /api/meetings/:id/process — starts async processing → returns 202

### Transcript & Summary
- GET  /api/meetings/:id/transcript — { transcript, status }
- GET  /api/meetings/:id/summary — { summary, bulletPoints, topics, status }

### Tasks
- GET  /api/meetings/:id/tasks — list tasks for a meeting
- PATCH /api/tasks/:id — update { "status": "done" } → returns updated task

## Data Shapes

Meeting: {
  id: string,
  title: string,
  date: string (ISO-8601),
  duration: number | null (seconds),
  status: "pending" | "uploading" | "transcribing" | "summarizing" | "complete" | "error",
  recordingUrl: string | null,
  transcript: string | null,
  summary: string | null (markdown),
  bulletPoints: string[] | null,
  topics: string[] | null,
  error: string | null,
  tasks: Task[],
  createdAt: string (ISO-8601),
  updatedAt: string (ISO-8601)
}

Task: {
  id: string,
  meetingId: string,
  description: string,
  assignee: string | null,
  status: "open" | "in_progress" | "done",
  priority: "high" | "medium" | "low" | null,
  createdAt: string,
  updatedAt: string
}

## Status Flow
pending → uploading → transcribing → summarizing → complete
                                              ↘ error

IMPORTANT: Only the 6 status values above are used. Anything else will break UI styling.

## /process Behavior
- Returns 202 Accepted (not 200) — processing happens in background
- If called while already transcribing/summarizing, returns 202 with "Already processing" — no duplicate job
- Poll GET /api/meetings/:id every 3s to watch status go transcribing → summarizing → complete
- On failure, status becomes "error" and error field has the message

## Summary Markdown Format (rendered by react-markdown + remark-gfm)
```
# Meeting Title

## Key Discussion Points
- Metric-rich bullet points (percentages, $ amounts, dates)
- ...

## Action Items
- [ ] Task description 🔴
- [ ] Task description — @assignee 🟡
- [ ] Task description 🟢

## Future Prospects
- Next steps, upcoming events, opportunities

---
*Topics: Topic1 · Topic2 · Topic3*
```

Priority emojis: 🔴 = high, 🟡 = medium, 🟢 = low

## Visual Design
Professional, modern, clean — Linear / Notion / Vercel aesthetic.

- Dark sidebar (#1e1e2e) with app logo and "Meetings" nav link
- Main content: white/light gray background
- Accent: indigo (#6366f1) for buttons, active states
- Cards with subtle shadows and rounded corners (border-radius 8-12px)
- Status badges:
  - pending → gray
  - uploading → blue
  - transcribing → yellow/amber (spinning animation)
  - summarizing → purple (pulsing animation)
  - complete → green
  - error → red
- Priority tags: red bg for high, yellow bg for medium, gray bg for low

## Pages & Features

### 1. Dashboard / Meeting List
- Sidebar with "Meetings" as main link
- Top bar with search input + "New Meeting" button (indigo)
- Filter chips: All | Pending | Complete | Error (horizontal scroll)
- Grid of meeting cards — each showing: title, relative date ("2h ago"), status badge, task count, recording duration
- Click card → navigate to meeting detail page
- Empty state illustration + "Create your first meeting" CTA when no meetings
- Loading skeleton cards while fetching

### 2. Create & Record Meeting
- Modal overlay (centered card, backdrop blur)
- Step indicator (1. Title → 2. Audio → 3. Process)
- Step 1: Text input for title, "Next" button
- Step 2: Two options side by side:
  - Record: Big red circle button → MediaRecorder API → live timer → stop → preview
  - Upload: Drag & drop zone OR file picker, accept audio/*, show filename after select
- Step 3: "Process Meeting" button (indigo, full width)
  - On click: POST audio, then POST process, then close modal and navigate to detail
- Disable "Next"/"Process" until current step is complete

### 3. Meeting Detail Page
- Back arrow + meeting title header
- Status stepper at top: visual progress bar with 5 dots (pending → uploading → transcribing → summarizing → complete)
- Three tabs: Transcript | Summary | Tasks (pill-style tabs)
- **Transcript tab:** Clean prose view (not monospace), with option to copy text
- **Summary tab:**
  - Render markdown with react-markdown + remark-gfm (GFM checklists, tables)
  - Fallback if summary is null: render bulletPoints[] as indigo bullet list + topics[] as tag chips
- **Tasks tab:**
  - Checkbox list — clicking calls PATCH /api/tasks/:id { status: "done" }
  - Checkbox toggles to checked, strikethrough text
  - Filter: All | Open | Done (small pills above list)
  - Each task shows: checkbox + description + priority badge + @assignee
- "Process" button shown if status is not "complete" and not "error" (re-process after error)
- "Delete" button (red) with confirmation dialog ("Are you sure? This cannot be undone.")
- Audio player (optional): if recordingUrl exists, show <audio> element with controls

### 4. Live Status Updates
- After calling /process, poll GET /api/meetings/:id every 3 seconds via setInterval
- Update status badge and stepper in real time
- On "complete": stop polling, show success notification, refresh full data
- On "error": stop polling, show error notification, surface error message

### 5. Responsive Behavior
- Desktop: sidebar visible, content fills rest
- Tablet (768-1024px): sidebar collapses to icons only
- Mobile (<768px): sidebar hidden, hamburger menu, stacked layout
- Meeting detail adjusts to single column on small screens

## State Handling (MUST implement all)

| Scenario | What to show |
|----------|-------------|
| Loading | Skeleton cards / spinner |
| Empty (no meetings) | Illustration + "Create your first meeting" CTA |
| Error fetching | Error banner with retry button |
| Meeting not found (404) | "Meeting not found" message |
| Processing in progress | Animated status stepper + "Processing..." label |
| Processing complete | Green checkmark + rendered summary |
| Processing failed | Red error banner with error message + "Retry" button |
| Uploading audio | Upload progress indicator |
| Deleting | Loading spinner on delete button + confirmation dialog |

## Non-functional Requirements
- Use fetch() for all API calls (no axios or other libraries needed)
- Toast/notification system for success/error actions (top-right, auto-dismiss 4s)
- Format dates with date-fns: relative for recent ("2 hours ago"), short format for older ("Jun 1")
- duration in seconds → format as "32 min" or "1h 12m"
- All API calls wrapped in try/catch with user-facing error messages
- No authentication needed (development mode)
- CORS preflight handled by backend (OPTIONS enabled)
```
