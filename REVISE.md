# Auth & Workspace Architecture

## Authentication

**Provider:** Supabase Auth
**Mechanism:** JWT Bearer tokens verified via JWKS (RS256)

### Flow

1. Frontend signs user in via Supabase JS SDK (Lovable Cloud)
2. Frontend sends `Authorization: Bearer <access_token>` with every API call
3. Backend `requireAuth` middleware:
   - Extracts token from `Authorization` header or `?token=` query param (mobile audio fallback)
   - Fetches JWKS from `SUPABASE_JWKS_URL` (cached 10 min)
   - Verifies JWT signature, issuer (`https://<ref>.supabase.co/auth/v1`), audience (`authenticated`)
   - Allows 60s clock skew tolerance
   - Checks `email_verified` claim, falls back to `auth.users` query via service role key
   - Attaches `req.user = { id: sub (Supabase UUID), email }`
4. No custom login/register endpoints — removed

### Error Codes

| Code | Status | Meaning |
|------|--------|---------|
| `unauthorized` | 401 | No token, expired, or invalid |
| `email_not_verified` | 403 | User's email not confirmed |
| `not_a_member` | 403 | User not in workspace |
| `insufficient_permissions` | 403 | Wrong role for action |
| `not_found` | 404 | Resource doesn't exist |
| `validation_error` | 400 | Bad request data |
| `server_error` | 500 | Internal error |

---

## Workspace System

### Models (Prisma)

- **Workspace** — id, name, slug (unique), members, meetings
- **WorkspaceMember** — userId (Supabase UUID), workspaceId, role
- **Meeting** — workspaceId, createdBy (Supabase UUID), title, status, recordingUrl, transcript, summary, tasks, shares
- **MeetingShare** — meetingId, sharedWithUserId (Supabase UUID), sharedByUserId
- **Task** — meetingId, description, assignee, status, priority

### Role Hierarchy

```
owner > admin > member > viewer
```

| Action | owner | admin | member | viewer |
|--------|-------|-------|--------|--------|
| Create meeting | ✅ | ✅ | ✅ | ❌ |
| Edit/delete own meeting | ✅ | ✅ | ✅ | ❌ |
| Edit/delete any meeting | ✅ | ✅ | ❌ | ❌ |
| Share meetings | ✅ | ✅ | ❌ | ❌ |
| Manage members | ✅ | ✅ | ❌ | ❌ |
| Delete workspace | ✅ | ❌ | ❌ | ❌ |

### Workspace Membership

- Checked by `requireWorkspaceMembership` middleware on every workspace-scoped route
- Queries `workspace_members` by `(userId = JWT sub, workspaceId = :wid from URL)`
- Attaches `req.workspace = { id, role }` for downstream use
- Cross-workspace tampering prevented — workspace ID always from URL, never from request body

### Meeting Access

- Meetings are scoped to a workspace via `workspaceId`
- `resolveMeeting()` helper checks:
  - Meeting belongs to the URL's workspace
  - Viewer role: only if `createdBy = user` or shared via `MeetingShare`
  - Non-viewer: full access to all meetings in workspace
- Response includes `access: "own"` (editable) or `access: "shared"` (read-only)

### Meeting Sharing

- **User-level sharing** via `MeetingShare` table
- `POST /api/workspaces/:wid/meetings/:mid/share` — share with user by Supabase UUID
- `DELETE /api/workspaces/:wid/meetings/:mid/share/:userId` — unshare
- `GET /api/workspaces/:wid/meetings/:mid/shared-with` — list shares
- Admin/owner only
- Shared users see meeting with `access: "shared"` — read-only

---

## CORS Configuration

- Allowed origins: `CORS_ORIGINS` env var + `*.lovableproject.com` + `*.lovable.app` + `*.onrender.com`
- Methods: GET, POST, PATCH, DELETE, OPTIONS
- Allowed headers: Content-Type, Authorization, X-LLM-*
- Exposed headers: Content-Disposition
- OPTIONS returns 204

---

## API Routes Summary

| Group | Base Path | Auth |
|-------|-----------|------|
| Workspaces | `/api/workspaces` | Supabase JWT |
| Meetings | `/api/workspaces/:wid/meetings` | Supabase JWT + workspace membership |
| Legacy | `/api/meetings` | Supabase JWT (resolves to default workspace) |
| Health | `/api/health` | None |

---

## Key Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `SUPABASE_JWKS_URL` | ✅ | JWKS endpoint for JWT verification |
| `SUPABASE_PROJECT_REF` | ✅ | Project ref for JWT issuer check |
| `SUPABASE_URL` | ✅ | For email-verified fallback + storage |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | For email-verified fallback + storage |
| `DATABASE_URL` | ✅ | PostgreSQL connection |
| `CORS_ORIGINS` | ✅ | Allowed frontend origins |
