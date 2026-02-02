# Strava Auto Server

Minimal FastAPI + SQLite backend with a React + Vite frontend. Receives Strava webhooks for near real-time activity ingestion and supports manual sync for reconciliation.

## Project Outline

- Backend: FastAPI (Python 3.12), SQLite via SQLAlchemy 2.x, httpx, Strava webhooks.
  - OAuth: Strava OAuth 2.0 (per-athlete sign-in with session cookies).
  - Webhooks: ingest new/updated activities, upsert into local DB.
  - API: health, automations CRUD, auth endpoints, activities listing.
- Frontend: React + Vite (dev port 5173) with React Query.
- CI: GitHub Actions runs unit tests with coverage; HTML report as artifact.

## Backend

### Environment Variables (see `.env.example`)

- `DATABASE_URL` (e.g. `sqlite:///../data/app.db` when started from `api/`).
- `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_REDIRECT_URI`.
- `STRAVA_WEBHOOK_VERIFY_TOKEN`, `STRAVA_WEBHOOK_CALLBACK_URL`.
- `APP_AUTH_SECRET` (session signing), `APP_SESSION_TTL` (seconds).
- `APP_AUTH_COOKIE_NAME`, `APP_COOKIE_SECURE`, `APP_COOKIE_SAMESITE`.
- `APP_REQUIRE_LOGIN` (set `0` to disable auth guard), `FRONTEND_BASE_URL`.

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
- `GET /api/session`, `POST /api/logout` - session status and logout.
- `GET /api/auth/strava/init` - returns OAuth URL.
- `GET /api/auth/strava/callback?code=...` - exchanges code, stores tokens.
- `GET /api/auth/strava/status` - connection and expiry info.
- `GET /api/webhooks/strava` - webhook verification handshake.
- `POST /api/webhooks/strava` - webhook event receiver.
- `GET /api/admin/webhooks/status` - webhook status metadata.
- `POST /api/admin/ingest` - manual sync of activities (optional `{"since": "YYYY-MM-DD"}`).
- `POST /api/admin/reapply_automations` - re-apply automations from a given date.
- `GET /api/activities?limit=20&offset=0` - paginated local activities (most recent first).

## Strava OAuth Setup

1. Configure your Strava app: set Authorization Callback URL to your `STRAVA_REDIRECT_URI`.
2. Start the API, open `GET /api/auth/strava/init` (or use the UI Sign in with Strava button) and follow the OAuth flow.
3. After callback, `users` and `oauth_tokens` are populated for that athlete and a session cookie is issued. Create a webhook subscription via `POST /api/admin/webhooks/subscribe`.

## Strava Webhook Setup

1. Expose a public HTTPS callback (e.g., Cloudflare Tunnel / Tailscale Funnel).
2. Set `STRAVA_WEBHOOK_CALLBACK_URL` to `https://your-public-host/api/webhooks/strava`.
3. Set `STRAVA_WEBHOOK_VERIFY_TOKEN` and create the subscription via `POST /api/admin/webhooks/subscribe`.

## Frontend

From `frontend/`:

```
pnpm install   # or npm install / yarn
pnpm run dev   # or npm run dev
```

Dev server: http://localhost:5173

CORS is preconfigured for `http://localhost:5173` in the API.

## Docker Deployment (Server)

Prereqs: Docker Engine + Docker Compose plugin on your Linux server.

1. Copy this repo to the server (or clone it).
2. Create a `.env` in the repo root (use `.env.example` as a template).
3. Build and run:

```
docker compose up -d --build
```

4. Check logs:

```
docker compose logs -f
```

Notes:
- The frontend container serves the UI on port 80 and proxies `/api` to the API container.
- Set `FRONTEND_BASE_URL` to your public URL (e.g., `https://your-host`) so OAuth redirects land on the UI.
- Strava webhooks require a public HTTPS callback URL.

### Free Registry Option (GitHub Container Registry)

Build and push:

```
docker login ghcr.io
docker build -t ghcr.io/<user>/strava-auto-api:latest -f api/Dockerfile .
docker build -t ghcr.io/<user>/strava-auto-frontend:latest ./frontend
docker push ghcr.io/<user>/strava-auto-api:latest
docker push ghcr.io/<user>/strava-auto-frontend:latest
```

Then set in `.env`:

```
API_IMAGE=ghcr.io/<user>/strava-auto-api:latest
FRONTEND_IMAGE=ghcr.io/<user>/strava-auto-frontend:latest
```

Pull and run:

```
docker compose pull
docker compose up -d
```

### Local Network Only

If you are not using a public domain yet, you can still run the stack on your LAN by setting:
- `FRONTEND_BASE_URL=http://<server-ip>`
- `STRAVA_REDIRECT_URI=http://<server-ip>/api/auth/strava/callback`

Strava webhooks still require a public HTTPS URL.

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

- `users`: athlete profile data from Strava (per-athlete sessions).
- `oauth_tokens`: per-athlete token rows (provider + athlete_id).
- `automations`: athlete-scoped rules.
- `activities`: denormalized columns plus `raw_json`; includes `athlete_id`.
- `automation_runs`: audit log for automation applications.
- `gear`: athlete gear list (shoes/bikes).
- `settings`: key/value, includes per-athlete cursors and webhook metadata.
- `webhook_events`: webhook payload log for idempotency/debug.

## Deployment Notes (Raspberry Pi later)

- Keep `DATABASE_URL` pointing to a writable path; default ensures `/data` exists when using `sqlite:////data/...` in containers.
- Webhook callbacks require a public HTTPS endpoint (reverse tunnel recommended on Pi).

## Next Steps (Frontend)

- Polish the Strava sign-in screen and profile badge (name/avatar).
- Activities list with basic filters (sport type) and pagination.
- Basic error toasts and loading states via React Query.

## Interpretation and Key Design Choices

- Topology: single-box deployment on your Pi via Docker Compose: frontend (React + TS), api (FastAPI Python), db (SQLite or Postgres), optional worker (for background jobs).
- Frontend (TypeScript/React):
  - Purpose: configure Automations and preview Recent Activities with “what would apply” overlays.
  - Tech: React + Vite + TypeScript, TanStack Query for data-fetching, Zod for front-end validation.
- Backend (Python):
  - Purpose: Strava integration, automation engine, webhook ingestion, effect application, and serving the UI.
  - Tech: FastAPI (async), Pydantic v2, httpx for Strava calls, SQLAlchemy 2.x for DB. Use uvicorn.
  - Patterns: idempotent handlers, retry with backoff, explicit rate-limit handling (Strava per-15-min and daily limits), structured logging.
- Database/Storage:
- For a small Pi deployment, SQLite is perfect (simple, zero-ops, durable). Consider WAL mode and backups (e.g., nightly copy or Litestream to object storage).
  - If you want multi-service concurrency/queueing, Postgres in Docker is fine on Pi (arm64 image) but heavier.
- Strava connectivity:
  - Webhooks (public HTTPS callback required). If your ISP blocks inbound, use a reverse tunnel (Cloudflare Tunnel or Tailscale Funnel) to avoid port-forwarding.
  - Manual sync is available for reconciliation or backfill.
- Automations model:
  - “Automation = flow(input → conditions → effects)”.
  - input is a Strava Activity (or “any new activity”).
  - conditions: composable filters (sport type, distance, elevation gain, start time/day, device, HR zones, power avg, route/segment match, title/description regex, etc.).
  - effects: Strava write operations (change sport type, update title/description, set commute, hide from feeds, add gear, add private note, name prefix/suffix, “commute”/“trainer” flags, etc.).
  - Include a dry-run evaluation so the UI can show “would apply”.
- Security & auth:
  - Store Strava OAuth tokens (access + refresh); consider encrypting at rest.
  - Sessions are signed cookies (set `APP_AUTH_SECRET`), so run behind HTTPS if exposed.
- Ops on Pi:
  - 64-bit Raspberry Pi OS recommended.
  - Docker Compose with healthchecks; logs to files with rotation.
  - Serve compiled frontend via FastAPI or Nginx; reverse-proxy /api.

Missing / Nice-to-Have Functionality
• Roles: admin-only controls or read-only viewers.
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
• users (athlete profile + identity)
• oauth_tokens (provider, athlete_id, access, refresh, scopes, expiry)
• activities (id, athlete_id, raw JSON, processed_at, last_evaluated_at, etag, hash)
• automations (id, name, enabled, priority, created_at, updated_at)
• automation_conditions (automation_id, type, operator, value JSON)
• automation_effects (automation_id, type, params JSON)
• automation_runs (id, activity_id, automation_id, matched, effects_applied JSON, error, idempotency_key, created_at)
• settings (key, value JSON) — e.g., webhook subscription metadata
• Index on activities(id, last_evaluated_at) and any fields you query (date, sport) once you denormalize them.

Data Flow (Webhook) 1. Webhook callback:
• Strava POSTs activity create/update/delete events to your callback URL.
• For new/updated activities: fetch detail, upsert into activities. 2. Evaluator (same request or queue):
• For each new/updated activity: evaluate automations (ordered by priority).
• For each match: stage effects; apply with idempotency key (activity_id, automation_id, effect_hash). 3. Effects Applier:
• Call Strava endpoints (e.g., PUT /activities/{id}) and record results in automation_runs. 4. Frontend:
• Recent activities list (from local DB), badges showing which automations matched (or would match in dry-run), and a wizard/editor for automations.

MOSCOW Requirements

Must have
• Local deploy on Raspberry Pi via Docker Compose.
• FastAPI backend with Strava OAuth (token refresh) and webhook ingestion.
• SQLite persistence with migrations.
• Automation model: conditions (subset), effects (subset), evaluation engine, idempotency.
• UI to list recent activities and create/enable/disable automations.
• Dry-run preview: “what would apply” without writing to Strava.
• Strava OAuth sign-in with session cookies (if exposed beyond localhost, serve over HTTPS).

Should have
• Reverse tunnel support option (Cloudflare/Tailscale) to enable webhooks.
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
• Role-based access control or team accounts.
• Heavy analytics dashboards (beyond basic lists and badges).

Roadmap & Order of Development

Phase 0 — Project skeleton
• Repos & packages: frontend/, api/, infra/.
• Docker Compose with services: api, frontend, db (SQLite via bind mount), optional worker for background jobs.
• Lint/format/test: Ruff, Black, Pytest; ESLint, Prettier, Vitest.

Phase 1 — Backend core (MVP) 1. FastAPI app with:
• /healthz
• /api/auth/strava/init & /api/auth/strava/callback (local redirect) — store tokens.
• /api/activities (list from DB), /api/automations CRUD. 2. DB models & migrations (SQLAlchemy 2.x + Alembic). 3. Strava client (httpx, async) with token refresh, rate-limit headers, retry/backoff. 4. Webhook ingestion:
• Accept Strava webhook events, fetch activity detail, upsert into DB. 5. Automation engine (first cut):
• Supported conditions: sport type, distance range, elapsed/avg speed range, time window (day-of-week), name/description regex.
• Supported effects: update activity name (prefix/suffix), set commute/trainer, set private/public, update description.
• Idempotency key + audit row per effect. 6. Apply effects via Strava PUT /activities/{id}; record results.

Phase 2 — Frontend MVP 1. Vite + React + TS, shadcn/ui, TanStack Query. 2. Screens:
• Dashboard: recent activities with icons, status chips (“Matched: X automations”, “Applied: Y effects”).
• Automations: list, enable/disable, create/edit wizard (Conditions → Effects → Review).
• Preview: given an activity, run dry-run and render matching automations/effects. 3. Auth guard: Strava OAuth session cookies if exposed beyond localhost.

Phase 3 — Quality & replay
• Replay: run an automation against N past activities (dry-run first; then “apply to matches”).
• Audit UI: per-activity effect history and error messages.
• Better conditions: cadence/HR/power presence, device, elevation gain, time-of-day buckets.

Phase 4 — Hardening & niceties
• Add a public callback using Cloudflare Tunnel or Tailscale Funnel.
• Ensure webhook handshake + verify token is configured.

Phase 5 — Hardening & niceties
• Backups (SQLite file snapshot + off-box copy if desired).
• Metrics (basic counters; even a /metrics page).
• Export/import automations JSON.
• Compose profiles for Postgres+Redis if you outgrow SQLite.
