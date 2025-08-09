# Verification Guide (Phase 1)

Run these commands locally or in CI to validate Phase 1. Each step stops on first failure.

```bash
# Formatting and lint
npx prettier . --check || exit 1
npx eslint . --ext .js || exit 1

# Docker Compose config
docker compose -f docker-compose.yml config -q || exit 1

# Start only Brain with app profile
docker compose --profile app up -d brain || exit 1

# Health endpoints
curl -fsS http://localhost:3000/healthz || exit 1
curl -fsS http://localhost:3000/readyz || (echo READY_FAIL && exit 1)
```

Optional security audit (non-blocking for now):
```bash
(cd Brain && npm audit --audit-level=high) || true
```
