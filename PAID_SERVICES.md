# Paid Services & Tools

All third-party services used by this project, their pricing, and what you need to set up.

---

## 1. Database — Supabase PostgreSQL

**Account:** https://supabase.com (free signup)

| Plan | Price | Limits |
|------|-------|--------|
| Free | $0 | 500 MB, 5 users, paused after 1 week inactivity |
| Pro | $25/mo | 8 GB, no auto-pause |

**What we use:** PostgreSQL database + connection pooler.

**Status:** ✅ Currently on **Pro tier** ($25/mo, no auto-pause).

---

## 2. LLM (Summarization) — DeepSeek API

**Account:** https://platform.deepseek.com

| Plan | Price | Model |
|------|-------|-------|
| Pay-as-you-go | $0.014/M tokens input | `deepseek-chat` (current) |
| | $0.028/M tokens output | |

**What we use:** Generates meeting summaries, bullet points, action items, marketing topics.

**Estimated cost per meeting:** ~$0.001–0.003 (negligible).

**Status:** ✅ Active — API key is already set.

---

## 3. Speech-to-Text (Cloud) — Deepgram Nova-3

**Account:** https://console.deepgram.com/signup

### Pricing

| Tier | Price | Card required? |
|------|-------|---------------|
| Free credit | **$200 pre-loaded** | ❌ **No** |
| After credit | $0.0043/min | ✅ |

**What we use:** Transcribes meeting audio on Render (no Python/Whisper available there).

**Skip this if:** Running locally with faster-whisper (Python) is **free**.

**Status:** ✅ **Active** — `DEEPGRAM_API_KEY` set; `STT_PROVIDER=deepgram`, model `nova-3`.

---

## 4. Hosting — Render

**Account:** https://dashboard.render.com

Two separate billing dimensions:

| Dimension | Plan | Price | Notes |
|-----------|------|-------|-------|
| Workspace | Hobby | **$0** | Free workspace plan (seats, bandwidth, compliance reports) |
| Instance type | Starter | **~$7/mo** | Always-on, 0.5 CPU / 512 MB, no spin-down |

**What we use:** Hosts the backend API with a **permanent HTTPS URL** (`meeting-assistant-api-rqf7.onrender.com`).

> **Don't confuse the two.** Workspace plan (Hobby/Pro/Scale/Enterprise) is a flat workspace fee; instance type (free/starter/standard/pro/...) is per-service compute. Paid instances (Starter+) are always-on; free instances spin down after ~15 min idle. A "Suspended by owner" response (`x-render-routing: suspend-by-user`) means the service was manually paused or billing lapsed.

**Status:** ✅ **Deployed & live** on Starter instance + Hobby workspace.

---

## 5. Frontend Hosting — Lovable

**Account:** https://lovable.dev

| Plan | Price |
|------|-------|
| Free | $0 (limited generations) |
| Pro | Paid |

**What we use:** Builds and hosts the frontend dashboard UI.

**Status:** ❌ Not yet set up (you build this with the Lovable prompt).

---

## 6. Tunneling (Dev only) — Cloudflare Tunnel

**Account:** None needed

| Tool | Price | Persistence |
|------|-------|-------------|
| `cloudflared tunnel` | **Free** | ❌ URL changes every restart |
| ngrok | Free tier (needs account) | ❌ URL changes every restart |
| Render (proper deploy) | Starter (~$7/mo) | ✅ Permanent URL |

**What we use:** Temporary HTTPS tunnel for dev/testing when the backend runs locally.

**Status:** ✅ Active (current URL: `https://return-auto-sim-trivia.trycloudflare.com`).

---

## Summary

| Service | Purpose | Cost | Account Needed | Setup Status |
|---------|---------|------|---------------|--------------|
| Supabase | Database | **Pro tier ($25/mo)** — no auto-pause | ✅ Done | ✅ Connected |
| DeepSeek | Summarization | ~$0.002/meeting | ✅ Done | ✅ Key set |
| Deepgram | Transcription (cloud) | $200 free credit | ✅ Done | ✅ Active (nova-3) |
| Render | Backend hosting | Hobby ws + Starter instance (~$7/mo) | ✅ Done | ✅ **Live** |
| Lovable | Frontend hosting | Free tier | ✅ Done | ✅ Active (dashboard) |
| Cloudflare | Dev tunnel | Free | ❌ None needed | ⚠️ Dev-only, ephemeral |

## Notes

- **Render** is now paid (~$7/mo, Starter instance). Keep a valid card on file — an unpaid balance is the main cause of services being suspended.
- **Supabase is on Pro** ($25/mo) — no auto-pause, so no more `503 db_unreachable` from an idle database.

---

*Last updated: 2026-08-23*
