# Strava Auto Server

Minimal FastAPI + SQLite backend with a React + Vite frontend. Polls Strava for recent activities on a schedule and exposes simple APIs for a future automation layer.

## Project Outline

- Backend: FastAPI (Python 3.12), SQLite via SQLAlchemy 2.x, httpx, APScheduler.
  - OAuth: Strava OAuth 2.0 (single-user MVP).
  - Polling: fetches recent activities, upserts into local DB.
  - API: health, automations CRUD, auth endpoints, activities listing.
- Frontend: React + Vite (dev port 5173) with React Query.
- CI: GitHub Actions runs unit tests with coverage; HTML report as artifact.

## Backend

### Environment Variables (see `.env.example`)

- `DATABASE_URL` (e.g. `sqlite:///../data/app.db` when started from `api/`).
- `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_REDIRECT_URI`.
- `POLLING_INTERVAL_SEC` (default 120).

### Run the API (dev)

```
uvicorn api.main:app --reload
```

Fish shell virtualenv activation (optional):

```
source .venv/bin/activate.fish
```

### Key Endpoints

- `GET /healthz` - service and env sanity.
- `GET /api/automations`, `POST /api/automations`, `DELETE /api/automations/{id}`.
- `GET /api/auth/strava/init` - returns OAuth URL.
- `GET /api/auth/strava/callback?code=...` - exchanges code, stores tokens.
- `GET /api/auth/strava/status` - connection and expiry info.
- `GET /api/activities?limit=20&offset=0` - paginated local activities (most recent first).

## Strava OAuth Setup

1. Configure your Strava app: set Authorization Callback URL to your `STRAVA_REDIRECT_URI`.
2. Start the API, open `GET /api/auth/strava/init` and follow the OAuth flow.
3. After callback, `oauth_tokens` has `provider='strava'`. Scheduler starts ingesting within `POLLING_INTERVAL_SEC`.

## Frontend

From `frontend/`:

```
pnpm install   # or npm install / yarn
pnpm run dev   # or npm run dev
```

Dev server: http://localhost:5173

CORS is preconfigured for `http://localhost:5173` in the API.

## Testing and Coverage

Make targets (shell agnostic; work in fish):

```
make setup          # create .venv and install Python deps
make test           # run unit tests
make coverage       # run tests with coverage and print summary
make coverage-html  # generate HTML report at htmlcov/index.html
```

CI enforces coverage threshold (75%). Edit `.coveragerc` to adjust.

## Data Model (SQLite)

- `automations`: minimal fields for MVP rules.
- `oauth_tokens`: single row (provider='strava') with tokens and expiry.
- `activities`: denormalized columns plus `raw_json`; idempotent upserts.
- `settings`: key/value, includes `last_seen_activity_time`.

## Deployment Notes (Raspberry Pi later)

- Keep `DATABASE_URL` pointing to a writable path; default ensures `/data` exists when using `sqlite:////data/...` in containers.
- APScheduler runs in-process; one API instance should own ingestion.

## Next Steps (Frontend)

- Add a simple auth banner: connect to Strava, show status, disconnect placeholder.
- Activities list with basic filters (sport type) and pagination.
- Basic error toasts and loading states via React Query.

## Interpretation and Key Design Choices

- Topology: single-box deployment on your Pi via Docker Compose: frontend (React + TS), api (FastAPI Python), db (SQLite or Postgres), optional worker (for background jobs) and scheduler (for polling).
- Frontend (TypeScript/React):
  - Purpose: configure Automations and preview Recent Activities with “what would apply” overlays.
  - Tech: React + Vite + TypeScript, TanStack Query for data-fetching, Zod for front-end validation.
- Backend (Python):
  - Purpose: Strava integration, automation engine, webhook/polling ingestion, effect application, and serving the UI.
  - Tech: FastAPI (async), Pydantic v2, httpx for Strava calls, SQLAlchemy 2.x for DB, APScheduler for polling. Use uvicorn.
  - Patterns: idempotent handlers, retry with backoff, explicit rate-limit handling (Strava per-15-min and daily limits), structured logging.
- Database/Storage:
  - For a single-user Pi MVP, SQLite is perfect (simple, zero-ops, durable). Consider WAL mode and backups (e.g., nightly copy or Litestream to object storage).
  - If you want multi-service concurrency/queueing, Postgres in Docker is fine on Pi (arm64 image) but heavier.
- Strava connectivity:
  - Preferred: Webhooks (needs a public HTTPS callback). If your ISP blocks inbound, use a reverse tunnel (Cloudflare Tunnel or Tailscale Funnel) to avoid port-forwarding.
  - Fallback MVP: Poll the Activities list on an interval with a since timestamp. Good for single user; add webhook later behind a tunnel.
- Automations model:
  - “Automation = flow(input → conditions → effects)”.
  - input is a Strava Activity (or “any new activity”).
  - conditions: composable filters (sport type, distance, elevation gain, start time/day, device, HR zones, power avg, route/segment match, title/description regex, etc.).
  - effects: Strava write operations (change sport type, update title/description, set commute, hide from feeds, add gear, add private note, name prefix/suffix, “commute”/“trainer” flags, etc.).
  - Include a dry-run evaluation so the UI can show “would apply”.
- Security & auth:
  - Store Strava OAuth tokens (access + refresh); consider encrypting at rest.
  - Don’t expose the Pi publicly unless via a tunnel; if exposed, terminate TLS and add a simple login.
- Ops on Pi:
  - 64-bit Raspberry Pi OS recommended.
  - Docker Compose with healthchecks; logs to files with rotation.
  - Serve compiled frontend via FastAPI or Nginx; reverse-proxy /api.

Missing / Nice-to-Have Functionality
• Auth & roles: Even if single-user, add a basic local account to guard the UI.
• Observability: Activity audit log (what matched, what effect applied, errors), structured logs, and a small “events” table.
• Idempotency keys: Prevent duplicate effect application on retries/webhook replays.
• Backoff & rate-limit awareness: Inspect Strava X-RateLimit-\* headers; throttle gracefully.
• Replay tooling: Re-evaluate past activities against a new automation (with dry-run option first).
• Conflict safety: If multiple automations match, define ordering and stop-on-match (or allow stacking if safe).
• Schema migrations: If SQLite → use Alembic migrations anyway so you can move to Postgres later.
• Unit/integration tests: Mock Strava API; file-based golden tests for the condition engine.

Storage Recommendation
• Start with SQLite (file: /data/app.db), WAL mode, one writer pattern via the API process.
• Tables (sketch):
• users (single user, local login if enabled)
• oauth_tokens (provider, access, refresh, scopes, expiry)
• activities (id, athlete_id, raw JSON, processed_at, last_evaluated_at, etag, hash)
• automations (id, name, enabled, priority, created_at, updated_at)
• automation_conditions (automation_id, type, operator, value JSON)
• automation_effects (automation_id, type, params JSON)
• automation_runs (id, activity_id, automation_id, matched, effects_applied JSON, error, idempotency_key, created_at)
• settings (key, value JSON) — e.g., polling interval
• Index on activities(id, last_evaluated_at) and any fields you query (date, sport) once you denormalize them.

Data Flow (Polling MVP) 1. Scheduler tick (e.g., every 2–5 min):
• Use Strava GET /athlete/activities with after (unix time of last seen) and ETag.
• For new/updated activities: upsert into activities. 2. Evaluator (same tick or queue):
• For each new/updated activity: evaluate automations (ordered by priority).
• For each match: stage effects; apply with idempotency key (activity_id, automation_id, effect_hash). 3. Effects Applier:
• Call Strava endpoints (e.g., PUT /activities/{id}) and record results in automation_runs. 4. Frontend:
• Recent activities list (from local DB), badges showing which automations matched (or would match in dry-run), and a wizard/editor for automations.

MOSCOW Requirements

Must have
• Local deploy on Raspberry Pi via Docker Compose.
• FastAPI backend with Strava OAuth (token refresh) and Activities polling ingestion.
• SQLite persistence with migrations.
• Automation model: conditions (subset), effects (subset), evaluation engine, idempotency.
• UI to list recent activities and create/enable/disable automations.
• Dry-run preview: “what would apply” without writing to Strava.
• Basic auth for the local UI (if exposed beyond localhost).

Should have
• Reverse tunnel support option (Cloudflare/Tailscale) to enable webhooks later.
• Structured logging, audit trail, and a per-activity “history”.
• Rate-limit aware client with retry/backoff.
• Replay past activities against new/edited automations.
• Import/export automations (JSON) and a test harness (sample activities).

Could have
• Postgres swap-in (compose profile) and a worker queue (RQ/Redis).
• Simple DSL or JSONLogic/CEL for conditions to enable complex filters.
• Segment/route-based conditions (match on polyline, distance to GPX).
• Notifications (email/Telegram) for failures or first-run success.
• Multi-athlete support (if you ever extend beyond your account).

Won’t have (for MVP)
• Real-time webhooks without a tunnel.
• Multi-tenant UI or roles.
• Heavy analytics dashboards (beyond basic lists and badges).

Roadmap & Order of Development

Phase 0 — Project skeleton
• Repos & packages: frontend/, api/, infra/.
• Docker Compose with services: api, frontend, db (SQLite via bind mount), scheduler (could be the same container running APScheduler).
• Lint/format/test: Ruff, Black, Pytest; ESLint, Prettier, Vitest.

Phase 1 — Backend core (MVP) 1. FastAPI app with:
• /healthz
• /api/auth/strava/init & /api/auth/strava/callback (local redirect) — store tokens.
• /api/activities (list from DB), /api/automations CRUD. 2. DB models & migrations (SQLAlchemy 2.x + Alembic). 3. Strava client (httpx, async) with token refresh, rate-limit headers, retry/backoff. 4. Polling scheduler (APScheduler in-process or a small separate worker):
• Fetch recent activities with after = last_seen (persist last cursor).
• Upsert into DB; mark needs_evaluation = true. 5. Automation engine (first cut):
• Supported conditions: sport type, distance range, elapsed/avg speed range, time window (day-of-week), name/description regex.
• Supported effects: update activity name (prefix/suffix), set commute/trainer, set private/public, update description.
• Idempotency key + audit row per effect. 6. Apply effects via Strava PUT /activities/{id}; record results.

Phase 2 — Frontend MVP 1. Vite + React + TS, shadcn/ui, TanStack Query. 2. Screens:
• Dashboard: recent activities with icons, status chips (“Matched: X automations”, “Applied: Y effects”).
• Automations: list, enable/disable, create/edit wizard (Conditions → Effects → Review).
• Preview: given an activity, run dry-run and render matching automations/effects. 3. Auth guard: simple login if exposed beyond localhost. If you keep it LAN-local, a lightweight guard is still advised.

Phase 3 — Quality & replay
• Replay: run an automation against N past activities (dry-run first; then “apply to matches”).
• Audit UI: per-activity effect history and error messages.
• Better conditions: cadence/HR/power presence, device, elevation gain, time-of-day buckets.

Phase 4 — Webhooks (optional enhancement)
• Add a public callback using Cloudflare Tunnel or Tailscale Funnel.
• Implement Strava webhook handshake & signature/verify token.
• Upsert event → queue evaluation (same engine). Keep polling as a fallback or for reconciliation.

Phase 5 — Hardening & niceties
• Backups (SQLite file snapshot + off-box copy if desired).
• Metrics (basic counters; even a /metrics page).
• Export/import automations JSON.
• Compose profiles for Postgres+Redis if you outgrow SQLite.
