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

**Status:** ✅ Currently on **Free tier**.

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

## 3. Speech-to-Text (Cloud) — Deepgram Nova-2

**Account:** https://console.deepgram.com/signup

### Pricing

| Tier | Price | Card required? |
|------|-------|---------------|
| Free credit | **$200 pre-loaded** | ❌ **No** |
| After credit | $0.0043/min | ✅ |

**What we use:** Transcribes meeting audio when deployed to Render (no Python/Whisper available).

**Skip this if:** Running locally with faster-whisper (Python) is **free**.

**Status:** ❌ **Not yet set up** — need to create a Deepgram account and add `DEEPGRAM_API_KEY` to Render env vars.

---

## 4. Hosting (Optional) — Render

**Account:** https://dashboard.render.com

| Plan | Price | Limits |
|------|-------|--------|
| Free | $0 | 750 hrs/mo, spins down after 15 min idle, 100 GB bandwidth |
| Starter | $7/mo | No spin-down |

**What we use:** Hosts the backend API with a **permanent HTTPS URL**.

**Estimated cost:** $0 (free tier is sufficient for development).

**Status:** ✅ Code ready. Not deployed yet.

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
| Render (proper deploy) | Free tier | ✅ Permanent URL |

**What we use:** Temporary HTTPS tunnel for dev/testing when the backend runs locally.

**Status:** ✅ Active (current URL: `https://return-auto-sim-trivia.trycloudflare.com`).

---

## Summary

| Service | Purpose | Cost | Account Needed | Setup Status |
|---------|---------|------|---------------|--------------|
| Supabase | Database | Free tier | ✅ Done | ✅ Connected |
| DeepSeek | Summarization | ~$0.002/meeting | ✅ Done | ✅ Key set |
| Deepgram | Transcription (cloud) | $200 free credit | ❌ **Needs signup** | ❌ Not yet |
| Render | Backend hosting | Free tier | ❌ **Needs signup** | ❌ Not deployed |
| Lovable | Frontend hosting | Free tier | ❌ **Needs signup** | ❌ Not built |
| Cloudflare | Dev tunnel | Free | ❌ None needed | ✅ Active |

## Setup priority

1. **Deepgram** (🔴 needed for Render deployment — transcription won't work otherwise)
2. **Render** (🟡 nice to have — permanent URL instead of ephemeral tunnels)
3. **Lovable** (🟢 build the frontend)

---

*Last updated: 2026-06-06*
