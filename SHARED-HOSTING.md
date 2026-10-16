# Portfolio and Strava on one HTTPS hostname

This opt-in deployment keeps Portfolio at `/` and serves Strava at `/strava/`.
The original `/api/webhooks/strava` and `/api/auth/strava/*` paths still go directly
to Strava; do not modify or recreate its webhook subscription or OAuth callback.
`/healthz` also remains Strava's health endpoint. `/api/health` belongs to Portfolio.

The normal `docker-compose.yml` and root-hosted Strava build remain unchanged.
Enable the overlay using both files (or persist
`COMPOSE_FILE=docker-compose.yml:docker-compose.portfolio.yml` in the private `.env`):

```sh
docker compose -f docker-compose.yml -f docker-compose.portfolio.yml build frontend
docker compose -f docker-compose.yml -f docker-compose.portfolio.yml up -d --no-build
```

Before enabling it:

1. Inspect both running Compose projects, image IDs, volumes, database paths and
   public callback configuration. Back up the configurations, credentials and
   databases privately; retain the previous frontend image for rollback.
2. Set `DOMAIN` to the existing hostname (without scheme/path). The overlay builds
   assets for `/strava/`, prefixes frontend API requests with `/strava`, and sets
   Strava's post-OAuth destination to `https://${DOMAIN}/strava`.
3. Verify the existing Portfolio network (default `personal-portfolio_default`,
   configurable with `PORTFOLIO_NETWORK`) and container DNS names
   `personal-portfolio-app` and `personal-portfolio-backend`. Only the edge Caddy
   service joins that network. It proxies directly to those services so original
   host/protocol headers are preserved without a second proxy hop.
4. Keep Portfolio's current immutable images, database, uploads and all keys.
   Set its persistent `APP_URL` to `https://${DOMAIN}` and update an explicitly
   configured `CORS_ALLOW_ORIGINS` to include that origin. Recreate only the
   application roles whose environment changed. This is an origin change, not
   a database migration or application-version upgrade. Public HTTPS is now the
   canonical login origin; old LAN cookies do not transfer to the new hostname.
5. Build and test before replacing services. Keep Caddy's existing certificate
   volumes and pin `EDGE_CADDY_IMAGE` to the existing Caddy image (a retained
   local tag is sufficient) to avoid an unrelated proxy upgrade. Deploy frontend and API, then switch Caddy. Never use `down -v`.

Run `python3 scripts/test-shared-routing.py` with Docker available to test actual
Caddy routing against isolated stub APIs and a production Strava frontend build.
It covers original GET/POST webhook paths, OAuth callback, Portfolio auth and API
routes, Strava's API prefix, slash redirect and asset retrieval. No real tokens or
production databases are used. `ROUTING_TEST_PYTHON_IMAGE` may select an existing
local Python image; the default is `python:3.12-alpine`.

After deployment, verify HTTPS, both login interfaces, authenticated existing
sessions/data, prefixed JS/CSS/API requests, the original webhook verification
handshake and unchanged callback configuration. Do not send fabricated activity
webhook events to the production receiver. Compare preserved database/upload
content and copy backups securely off-device.

Rollback: restore the previous `.env` and Compose selection, restore the previous
Strava frontend image reference, and recreate only affected services. Restore the
previous Portfolio origin with its existing version. Reload/recreate Caddy with
the original Caddyfile and its same certificate volumes. No database restore is
needed for this configuration-only change unless independent evidence shows a
separate data problem.
