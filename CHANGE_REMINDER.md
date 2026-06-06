# Change Reminder — What Doesn't Sync Automatically

When you push backend changes to GitHub, **the frontend (Lovable) does NOT auto-update**. You must manually update the frontend code for these changes:

---

## API Response Shape

| Backend change | Frontend needs | Example |
|---------------|---------------|---------|
| Rename a response field | Update all `data.fieldName` references | `meeting.title` → `meeting.name` |
| Change a field type | Update TypeScript/types | `duration` changes from `number` to `string` |
| Add a new field in response | Optional — only if frontend uses it | |
| Remove a response field | Remove all references to it | |

## API Endpoints

| Backend change | Frontend needs | Example |
|---------------|---------------|---------|
| Add new endpoint | Write new `fetch()` / `useQuery()` call | `PATCH /api/meetings/:id` |
| Change URL path | Update all fetch URLs | `/api/meeting` → `/api/meetings` |
| Change HTTP method | Update method in fetch call | `GET` → `POST` |
| Remove endpoint | Remove all frontend code using it | |

## Request Body / Parameters

| Backend change | Frontend needs | Example |
|---------------|---------------|---------|
| Add required field | Always include it in request | `{ title: string }` now also needs `{ date: string }` |
| Remove accepted field | Stop sending it | |
| Change field name | Update all mutation code | `{ taskId }` → `{ id }` |
| Change query param | Update URL params | `?page=1` → `?offset=0` |

## Status / Enum Values

| Backend change | Frontend needs | Example |
|---------------|---------------|---------|
| New meeting status | Add to UI status badge styling | Adding `"archived"` status |
| Rename status | Update all conditional styling | `"done"` → `"completed"` |
| Remove status | Remove UI handling for it | |

## Environment / Config

| Change | Action needed |
|--------|---------------|
| API base URL (new tunnel/deploy) | Update `API_BASE` in frontend code |
| CORS origins | Add new frontend URL to backend `.env` + restart |
| New env var required | Set it in Render dashboard if deploying |

## Database Schema

| Change | Frontend impact |
|--------|----------------|
| Add new model/table | Build new UI pages for it |
| Change field type | May affect how data renders |
| Relation changes | May need new nested data handling |

---

## Quick Checklist Before Frontend Work

When you push backend code, ask yourself:

- [ ] Did I change any API response field **names** or **types**?
- [ ] Did I add or remove any **endpoints**?
- [ ] Did I change any **request body** requirements?
- [ ] Did I add/rename/remove any **status values**?
- [ ] Did I change the **API base URL**?

If yes → update the frontend fetch/query code in Lovable.

If no → frontend should work as-is. ✅

---

*Last updated: 2026-06-06*
