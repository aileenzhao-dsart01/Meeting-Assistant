# Lovable UI Prompt

Copy and paste the following into Lovable when creating a new project.

---

```
Build a meeting assistant dashboard for marketing, sales, IT, and security teams.

## API Base URL
https://meeting-assistant-api-rqf7.onrender.com

All responses follow this exact envelope:
- Success: { "success": true, "data": ... }
- Error:   { "error": "snake_case_code", "message": "Human readable" }

Errors are always JSON — never HTML. Read json.error on failure.

## Auth

Uses **Supabase Auth**. The frontend already uses Lovable Cloud (Supabase) for sign-in. Every API call must include:

```typescript
const { data: { session } } = await supabase.auth.getSession();
const token = session?.access_token;

// All fetch calls:
fetch("https://meeting-assistant-api-rqf7.onrender.com/api/...", {
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
});
```

- No token → `401 { error: "unauthorized" }` → redirect to login
- Unverified email → `403 { error: "email_not_verified" }`
- Not a workspace member → `403 { error: "not_a_member" }`
- Insufficient role → `403 { error: "insufficient_permissions" }`

The old `/api/auth/login` and `/api/auth/register` endpoints are **removed** — all auth goes through Supabase.

## API Endpoints

### Workspaces
- GET  /api/workspaces — list my workspaces
- POST /api/workspaces — create { name }
- GET  /api/workspaces/:wid — workspace details
- GET  /api/workspaces/:wid/members — list members
- POST /api/workspaces/:wid/members — add { userId, role? } (admin+)

### Meetings (workspace-scoped — primary API)
- GET    /api/workspaces/:wid/meetings — list (?status=complete&page=1&limit=20)
- POST   /api/workspaces/:wid/meetings — create { title }
- GET    /api/workspaces/:wid/meetings/:mid — full detail (includes access: "own" | "shared")
- PATCH  /api/workspaces/:wid/meetings/:mid — update { title?, duration? } (own only)
- DELETE /api/workspaces/:wid/meetings/:mid — delete (own only)
- POST   /api/workspaces/:wid/meetings/:mid/audio — upload audio (multipart, field: "audio")
- GET    /api/workspaces/:wid/meetings/:mid/audio — download audio
- POST   /api/workspaces/:wid/meetings/:mid/process — start processing → 202
- GET    /api/workspaces/:wid/meetings/:mid/transcript — { transcript, status }
- GET    /api/workspaces/:wid/meetings/:mid/summary — { summary, bulletPoints, topics, status }
- GET    /api/workspaces/:wid/meetings/:mid/tasks — list tasks
- PATCH  /api/workspaces/:wid/meetings/:mid/tasks/:tid — update task { status?, assignee?, priority? }
- POST   /api/workspaces/:wid/meetings/:mid/share — share with user { userId } (admin)
- DELETE /api/workspaces/:wid/meetings/:mid/share/:userId — unshare (admin)
- GET    /api/workspaces/:wid/meetings/:mid/shared-with — list shares

### Access Rules
| Role   | Create | Edit/Delete Own | Edit/Delete Any | Share |
|--------|--------|----------------|-----------------|-------|
| owner  | ✅     | ✅             | ✅              | ✅    |
| admin  | ✅     | ✅             | ✅              | ✅    |
| member | ✅     | ✅             | ❌              | ❌    |
| viewer | ❌     | ❌             | ❌              | ❌    |

- Meeting responses include `access: "own"` (can edit) or `access: "shared"` (read-only)
- Hide Edit/Delete/Upload/Process buttons when `access === "shared"`

### Legacy (backward compat — requires auth)
- GET  /api/meetings — list my default workspace meetings
- POST /api/meetings — create { title }
- GET  /api/meetings/:id — meeting detail
- DELETE /api/meetings/:id — delete
- POST /api/meetings/:id/audio — upload audio
- GET  /api/meetings/:id/audio — download audio
- POST /api/meetings/:id/process — start processing
- GET  /api/meetings/:id/transcript — get transcript
- GET  /api/meetings/:id/summary — get summary
- GET  /api/meetings/:id/tasks — list tasks
- PATCH /api/tasks/:id — update task

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
  access: "own" | "shared",        // ← determines edit visibility
  workspaceId: string,
  createdBy: string,                // Supabase user UUID
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

## Data Fetching with TanStack Query (React Query)
Use TanStack Query for all API calls — it handles caching, auto-refetching, loading/error states, and polling out of the box.

### Query Keys
- `["meetings"]` — meeting list
- `["meeting", id]` — single meeting detail
- `["tasks", meetingId]` — tasks for a meeting

### Auto-Polling for Real-time Status
The backend processes meetings asynchronously. When you call POST /api/meetings/:id/process, it returns immediately (202) and the meeting status progresses:
pending → uploading → transcribing → summarizing → complete | error

**Use TanStack Query's refetchInterval for live polling:**

```typescript
// Auto-poll meeting detail every 3s while processing
const { data, isLoading } = useQuery({
  queryKey: ["meeting", meetingId],
  queryFn: () => fetch(`/api/meetings/${meetingId}`).then(r => r.json()),
  refetchInterval: (query) => {
    const status = query.state.data?.data?.status;
    // Poll every 3s while processing, stop when complete or error
    if (status === "transcribing" || status === "summarizing") return 3000;
    return false; // stop polling
  },
});
```

### Mutations

```typescript
// Create meeting
const createMeeting = useMutation({
  mutationFn: (title) => fetch("/api/meetings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  }).then(r => r.json()),
  onSuccess: () => queryClient.invalidateQueries({ queryKey: ["meetings"] }),
});

// Update task
const updateTask = useMutation({
  mutationFn: ({ id, status }) => fetch(`/api/tasks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  }).then(r => r.json()),
  onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tasks"] }),
});
```

### Optimistic Updates (Tasks)
When a user checks a task as "done", update the cache immediately before the API responds:

```typescript
const updateTask = useMutation({
  mutationFn: ({ id, status }) => ...,
  onMutate: async ({ id, status }) => {
    await queryClient.cancelQueries({ queryKey: ["tasks"] });
    const previous = queryClient.getQueryData(["tasks"]);
    queryClient.setQueryData(["tasks"], (old) => ({
      data: old.data.map(t => t.id === id ? { ...t, status } : t)
    }));
    return { previous };
  },
  onError: (err, vars, context) => {
    queryClient.setQueryData(["tasks"], context.previous);
  },
  onSettled: () => queryClient.invalidateQueries({ queryKey: ["tasks"] }),
});
```

### API Helper
```typescript
const API_BASE = "https://7dc1ed860c45c233-142-112-231-209.serveousercontent.com";

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error || "Request failed");
  return json.data;
}
```

## Non-functional Requirements
- Use TanStack Query for all data fetching (not raw fetch() calls in components)
- Toast/notification system for success/error actions (top-right, auto-dismiss 4s)
- Format dates with date-fns: relative for recent ("2 hours ago"), short format for older ("Jun 1")
- duration in seconds → format as "32 min" or "1h 12m"
- All API calls wrapped in try/catch with user-facing error messages
- No authentication needed (development mode)
- CORS preflight handled by backend (OPTIONS enabled)
```
