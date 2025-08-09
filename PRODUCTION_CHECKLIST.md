# Production Checklist (Phase 1: Minimal, Safe Productionization)

Scope: Docker Compose single-host, no reverse proxy changes, Brain app only for code edits.

## Docker Compose profiles and health
- Ensure `brain` has: `profiles: ["app"]`, `restart: unless-stopped`, healthcheck against `/healthz`, and json-file log rotation (10m/5 files).
- Validate compose syntax.

## Brain service health/readiness
- `GET /healthz` returns `{status:"ok"}`.
- `GET /readyz` checks essential deps quickly (Supabase health) and returns 200 only when ready; 503 otherwise.
- Graceful shutdown on SIGTERM using `server.close()`.

## Logs
- Docker json-file rotation: `max-size: 10m`, `max-file: 5` on `brain`.
- Continue Winston structured logs; avoid secrets in logs.

## CI security scan (non-blocking)
- Run `npm audit --audit-level=high` in Brain after lint/prettier; do not fail job yet.

## Rollout/Rollback (Phase 1)
- Rollout: `docker compose --profile app up -d brain`.
- Rollback: re-run with previous tag if needed (handled outside this phase).

## What changed (Phase 1)
- `Brain/server.js`: added `/healthz`, `/readyz`, and graceful shutdown.
- `docker-compose.yml`: brain profile, healthcheck targets `/healthz`, log rotation.
- `.github/workflows/ci.yml`: added non-blocking `npm audit`.

## Out of scope (Phase 1)
- Reverse proxy/TLS, backups, monitoring stack, secrets changes.
