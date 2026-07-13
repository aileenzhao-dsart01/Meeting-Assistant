# Lovable Prompt — Invite Flow & Email Setup

The backend + email are fully configured. Here's what changed and what the frontend needs to do:

---

## 4 Issues Resolved

### #1 — Invite Email Branding
Supabase SMTP is now set to SendGrid with sender name "Compass Meetings". The "Verify your email" confirmation emails now come from Compass Meetings, not Supabase generic.

### #2 — Login Redirect (was localhost)
Supabase Site URL is now `https://compassmeetings.com`. After email verification, users land on the live app.

### #3 — In-App Invite Notification
New endpoint: `GET /api/me/invites` — returns all pending invites for the logged-in user's email.

```json
{
  "success": true,
  "data": {
    "invites": [
      {
        "id": "...",
        "workspaceId": "...",
        "workspaceName": "Marketing Team",
        "role": "member",
        "status": "pending",
        "createdAt": "2026-07-12T...",
        "acceptLink": "https://compassmeetings.com/invite/xxx?w=yyy"
      }
    ]
  }
}
```

Call this on dashboard load. If `invites.length > 0`, show a notification badge / panel with "Accept" buttons.

### #4 — Accept Invite (the main bug)
The old `accept_workspace_invite` RPC is gone. The frontend already switched to:

```
POST /api/workspaces/:wid/invites/:inviteId/accept
Authorization: Bearer <token>
```

The invite page reads `?w=<workspaceId>` from URL, extracts the `:wid` and `:inviteId`, and calls the endpoint.

Old copied links are dead — re-copy from Pending invites list.

---

## Workspace Invite Flow (End-to-End)

1. **Admin** → `POST /api/workspaces/:wid/invites { email, role }` → backend stores invite + sends email via SendGrid
2. **Invitee receives email** → subject "You're invited to join Workspace X on Compass Meetings" → click link
3. **If not signed up** → Supabase shows signup → verification email sent via SendGrid → user confirms → redirected to `https://compassmeetings.com/invite/<id>?w=<wid>`
4. **If signed in** → lands on `https://compassmeetings.com/invite/<id>?w=<wid>` → "Accept Invite" button
5. **Accept** → `POST /api/workspaces/:wid/invites/:inviteId/accept` → backend creates WorkspaceMember + marks invite accepted → redirect to dashboard
6. **Dashboard** → `GET /api/me/invites` returns empty → notification gone

---

## Email Config Summary

| Service | Purpose | Setup Location |
|---------|---------|---------------|
| SendGrid | Sends all emails | Free account at sendgrid.com |
| Supabase SMTP | Verification / password reset emails | Supabase → Auth → Settings → SMTP |
| Backend SMTP | Workspace invite emails | Render → Environment vars |

Both use the same SendGrid API key. No conflict.

---

## API Changes Summary (for reference)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/me/invites` | List pending invites for current user |
| `POST` | `/api/workspaces/:wid/invites` | Create invite `{ email, role? }` |
| `GET` | `/api/workspaces/:wid/invites` | List workspace invites (admin) |
| `POST` | `/api/workspaces/:wid/invites/:inviteId/accept` | Accept invite (JWT email must match) |
| `DELETE` | `/api/workspaces/:wid/invites/:inviteId` | Cancel invite (admin) |
| `POST` | `/api/workspaces/:wid/resolve-email` | `{ email }` → `{ userId }` lookup |

---

## What the Frontend Needs to Do

1. **Dashboard** — on mount, call `GET /api/me/invites`. Show notification panel with Accept buttons if any.
2. **Invite page** (`/invite/:inviteId`) — read `?w=<workspaceId>` from URL, show "Accept Invite" button that calls `POST /api/workspaces/:wid/invites/:inviteId/accept`
3. **On accept success** — redirect to dashboard (they're now a workspace member)
4. **On accept error** (403 "different email") — user is logged in with wrong account, tell them to switch
5. **Remove** any remaining references to the old `accept_workspace_invite` RPC
