# Lovable Frontend: Auth + Workspace Integration Prompt

Copy and paste this into Lovable's chat:

---

I need you to update the Meeting Assistant dashboard to work with the new backend that now has authentication and workspace isolation.

## Context

The backend has been upgraded from a fully open API to one with:
- **JWT authentication** (register/login with email + password)
- **Workspace isolation** — each team has their own workspace; users only see meetings they have permission to
- **Role-based access** — owner, admin, member roles per workspace
- **Cross-workspace sharing** — meetings can be shared read-only with other workspaces

## How Auth Works

1. User registers or logs in → gets back `{ user, token, workspaces }`
2. All subsequent API calls include `Authorization: Bearer <token>` header
3. Token expires in 24h — user must re-login after that
4. Store token in localStorage/sessionStorage

## What the Backend Returns

All API responses follow the same format:
```json
// Success
{ "success": true, "data": { ... } }

// Error
{ "success": false, "error": "message" }
```

## API Endpoints

### Auth (no token required)

**POST `/api/auth/register`**
```json
// Request
{ "email": "user@example.com", "password": "test123", "name": "User Name" }

// Response
{
  "success": true,
  "data": {
    "user": { "id": "...", "email": "...", "name": "User Name" },
    "token": "eyJhbGciOi...",
    "workspaces": [
      { "id": "cmr...", "name": "User's Workspace", "slug": "user-s-workspace", "role": "owner" }
    ]
  }
}
```

**POST `/api/auth/login`**
```json
// Request
{ "email": "user@example.com", "password": "test123" }

// Response — same format as register
```

**GET `/api/auth/me`** (requires token)
```json
{
  "success": true,
  "data": {
    "user": { "id": "...", "email": "...", "name": "User Name" },
    "workspaces": [
      { "id": "...", "name": "My Workspace", "slug": "my-workspace", "role": "owner" }
    ]
  }
}
```

### Seed Admin Account
Pre-existing: `admin@meeting-assistant.local` / `admin123` — has access to all legacy meetings under "Default Workspace".

### Workspaces (require token)

**GET `/api/workspaces`** — List user's workspaces
**POST `/api/workspaces`** — Create workspace `{ "name": "Team Name" }`
**GET `/api/workspaces/:wid`** — Workspace details
**PATCH `/api/workspaces/:wid`** — Update name `{ "name": "New Name" }` (admin+)
**GET `/api/workspaces/:wid/members`** — List members
**POST `/api/workspaces/:wid/members`** — Add member `{ "email": "...", "role": "member" }` (admin+)

### Meetings — New Primary API (workspace-scoped)

All paths under `/api/workspaces/:wid/meetings`.

**GET `/api/workspaces/:wid/meetings?status=&page=1&limit=20`** — List meetings (owned + shared)
**POST `/api/workspaces/:wid/meetings`** — Create `{ "title": "Meeting Name" }`
**GET `/api/workspaces/:wid/meetings/:mid`** — Get meeting detail (includes `access: "own" | "shared"`)
**PATCH `/api/workspaces/:wid/meetings/:mid`** — Update `{ title?, duration? }` (own only)
**DELETE `/api/workspaces/:wid/meetings/:mid`** — Delete (own only)
**POST `/api/workspaces/:wid/meetings/:mid/audio`** — Upload audio (multipart, field: `audio`)
**GET `/api/workspaces/:wid/meetings/:mid/audio`** — Download audio (binary)
**POST `/api/workspaces/:wid/meetings/:mid/process`** — Start transcription
**GET `/api/workspaces/:wid/meetings/:mid/transcript`** — Get transcript
**GET `/api/workspaces/:wid/meetings/:mid/summary`** — Get summary
**GET `/api/workspaces/:wid/meetings/:mid/tasks`** — List tasks
**PATCH `/api/workspaces/:wid/meetings/:mid/tasks/:tid`** — Update task
**POST `/api/workspaces/:wid/meetings/:mid/share`** — Share `{ "targetWorkspaceId": "..." }` (admin)
**DELETE `/api/workspaces/:wid/meetings/:mid/share?targetWorkspaceId=xxx`** — Unshare (admin)

### Legacy APIs (still work but DEPRECATED)

The old flat `/api/meetings/*` routes still work. They require the auth token and resolve to the user's default workspace. Use these as a drop-in replacement while migrating:

- `GET /api/meetings`, `POST /api/meetings`, `GET /api/meetings/:id`, etc.
- `PATCH /api/meetings/:id`, `DELETE /api/meetings/:id`
- `POST /api/meetings/:id/audio`, `GET /api/meetings/:id/audio`
- `POST /api/meetings/:id/process`
- `GET /api/meetings/:id/transcript`, `GET /api/meetings/:id/summary`
- `GET /api/meetings/:id/tasks`, `PATCH /api/tasks/:id`

## What the Frontend Needs to Implement

### 1. Login / Register Screen
- Form with email + password (login), optionally name (register)
- On success, store token and navigate to dashboard
- Auto-redirect to login if any API returns 401

### 2. Workspace Selection
- After login, if user has multiple workspaces → show workspace picker
- Active workspace ID is sent as the `:wid` in all workspace-scoped API calls
- "Create new workspace" option
- Admin users can manage members (add/remove by email)

### 3. Dashboard (Meetings List)
- Fetch meetings for selected workspace: `GET /api/workspaces/:wid/meetings`
- Filter by status: `?status=complete`
- Each meeting shows `access` field: "own" = full edit, "shared" = read-only
- Shared meetings should show a visual indicator (different card color, "Shared" badge)

### 4. Meeting Detail / Edit
- Read-only mode for shared meetings (hide edit/delete/upload buttons)
- Show "Shared from [workspace name]" for shared meetings
- Full CRUD for owned meetings

### 5. Audio Upload & Processing
- Same as before, but POST to the workspace-scoped path
- Upload: `POST /api/workspaces/:wid/meetings/:mid/audio`
- Process: `POST /api/workspaces/:wid/meetings/:mid/process`
- Poll meeting status via `GET /api/workspaces/:wid/meetings/:mid`

### 6. Sharing (Admin Only)
- "Share" button on owned meetings
- Opens modal to select a target workspace (need to fetch all workspaces the user has access to)
- Shows list of workspaces the meeting is already shared with
- Can unshare from within the same UI

## Migration Path

If you want a quick migration without building the full workspace UI:

1. **Immediately**: Add auth token to all existing API calls. The legacy `/api/meetings` routes work the same way.
2. **Phase 1**: Add login/register screen before the dashboard
3. **Phase 2**: Make the workspace-scoped routes the primary ones
4. **Phase 3**: Add workspace management, member management, sharing UI

## Response Format Examples

**Meeting list (workspace-scoped):**
```json
{
  "success": true,
  "data": {
    "meetings": [
      {
        "id": "cmr...",
        "title": "Q3 Review",
        "date": "2026-07-09T01:00:00.000Z",
        "duration": null,
        "status": "complete",
        "taskCount": 3,
        "workspaceId": "cmr..."
      }
    ],
    "total": 18,
    "page": 1,
    "limit": 20
  }
}
```

**Meeting detail:**
```json
{
  "success": true,
  "data": {
    "id": "cmr...",
    "title": "Q3 Review",
    "date": "2026-07-09T01:00:00.000Z",
    "status": "complete",
    "transcript": "...",
    "summary": "## Summary...",
    "bulletPoints": ["Point 1", "Point 2"],
    "topics": ["SEO", "PPC"],
    "tasks": [{ "id": "...", "description": "Do X", "status": "open" }],
    "access": "own",
    "workspaceId": "cmr..."
  }
}
```

## CORS Config

The backend currently allows CORS from: `http://localhost:5173`, `http://localhost:3000`, `http://localhost:8080`, `https://berkeley-nvidia-signals-federation.trycloudflare.com`, `*.lovableproject.com`, `*.lovable.app`, `*.onrender.com`. If your Lovable preview URL is different, it may be blocked — ask the backend dev to add it in `CORS_ORIGINS`.
