# Lovable Frontend Prompt — Supabase Auth Migration

The backend auth system has changed. Copy-paste this into Lovable:

---

## Auth Change: Supabase JWT Only (No More Custom Login)

The backend at `https://meeting-assistant-api-rqf7.onrender.com` now verifies **Supabase JWTs exclusively**. The old `/api/auth/login` and `/api/auth/register` endpoints are **removed**.

## What Changed

| Before | After |
|--------|-------|
| Custom email/password login | Supabase Auth only |
| Backend JWT in localStorage | Supabase JWT from `supabase.auth.getSession()` |
| Login/Register endpoints exist | Login/Register endpoints are **gone** |
| `401` response format: `{ success: false, error: "..." }` | `401` response format: `{ error: "unauthorized", message: "..." }` |
| Workspaces used email for user ID | Workspaces use Supabase UUID (`auth.user().id`) |

## How to Integrate

Your frontend already uses Supabase Auth (Lovable Cloud). The JWT from `supabase.auth.getSession().access_token` is what the backend now accepts.

```typescript
// ✅ Get the Supabase JWT
const { data: { session } } = await supabase.auth.getSession();
const token = session?.access_token;

// ✅ Send it as Bearer token
const res = await fetch("https://meeting-assistant-api-rqf7.onrender.com/api/workspaces", {
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
});

// ❌ Old custom login — REMOVED
// const res = await fetch("/api/auth/login", { ... });
```

## Key Requirements

1. **Auth guard**: Check `supabase.auth.getSession()` exist before dashboard loads. If no session → show login.
2. **Bearer token**: Plumb `session.access_token` into every API call's `Authorization` header.
3. **Email verification**: The backend rejects unverified emails with `403 { error: "email_not_verified" }`. Your Supabase project settings should require email confirmation.
4. **New error format**: 401 → `{ error: "unauthorized", message: "..." }`. 403 → `{ error: "not_a_member", ... }` or `{ error: "insufficient_permissions", ... }`.
5. **User ID**: Backend uses `req.user.id` = Supabase UUID (`auth.user().id`). Workspace member `userId` fields are Supabase UUIDs.

## API Summary

### Workspaces
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/workspaces` | ✅ | List my workspaces |
| POST | `/api/workspaces` | ✅ | Create `{ name }` |
| GET | `/api/workspaces/:wid` | ✅ | Workspace details |
| GET | `/api/workspaces/:wid/members` | ✅ | List members |
| POST | `/api/workspaces/:wid/members` | ✅ (admin) | Add `{ userId, role? }` |

### Meetings
All under `/api/workspaces/:wid/meetings`. Response includes `access: "own" | "shared"`.

| Method | Path | Access | Description |
|--------|------|--------|-------------|
| GET | `/` | member | List meetings |
| POST | `/` | member+ | Create `{ title }` |
| GET | `/:mid` | member | Get meeting |
| PATCH | `/:mid` | own | Update |
| DELETE | `/:mid` | own | Delete |
| POST | `/:mid/audio` | own | Upload audio |
| GET | `/:mid/audio` | member | Download audio |
| POST | `/:mid/process` | own | Start processing |
| GET | `/:mid/transcript` | member | Get transcript |
| GET | `/:mid/summary` | member | Get summary |
| GET | `/:mid/tasks` | member | List tasks |
| PATCH | `/:mid/tasks/:tid` | own | Update task |
| POST | `/:mid/share` | admin | Share `{ userId }` |
| DELETE | `/:mid/share/:userId` | admin | Unshare |

### Access Rules (Backend Enforces)
| Role | Create | Edit/Delete Own | Edit/Delete Any | Share |
|------|--------|-----------------|-----------------|-------|
| owner | ✅ | ✅ | ✅ | ✅ |
| admin | ✅ | ✅ | ✅ | ✅ |
| member | ✅ | ✅ | ❌ | ❌ |
| viewer | ❌ | ❌ | ❌ | ❌ |

### Error Codes the Frontend Handles
- `401 unauthorized` → redirect to login
- `403 email_not_verified` → show "verify your email"
- `403 not_a_member` → user not in this workspace
- `403 insufficient_permissions` → can't do that action
- `404 not_found` → meeting/workspace doesn't exist
- `409 conflict` → already exists (duplicate share)

## Migration Steps (In Order)

1. **Test auth flow**: Make sure `supabase.auth.getSession()` works and you can get a JWT from the existing Supabase login
2. **Add Bearer header**: Plumb the Supabase JWT into the API helper's headers
3. **Remove login/register pages**: The custom email/password forms are no longer needed — Supabase handles auth
4. **Update error handling**: Switch from checking `json.error` string to checking `json.error` code
5. **Workspace user IDs**: When adding members to a workspace, send Supabase UUID (not email)
