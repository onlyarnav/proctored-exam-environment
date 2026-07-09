# Phase 1 — Foundation & Infrastructure

**Goal:** A running local stack with all five services scaffolded, talking to each other, with auth working end-to-end and every non-negotiable convention from `CLAUDE.md` (§2–§7) already wired in at the skeleton level — not bolted on later. Nothing exam-specific yet.

**Why this phase matters more than it looks:** every convention that's expensive to retrofit (correlation IDs, error envelope, RBAC, idempotency plumbing, structured logging) gets established here. Phase 2 onward should only be adding domain logic on top of an already-solid skeleton.

---

## Scope

- Monorepo tooling (npm workspaces for TS packages, Go modules per Go service, Python venv/poetry for ml-service)
- Docker Compose: Postgres, Redis, MinIO, and all 5 services, with healthchecks and a shared network
- Postgres schema v1: `users`, `refresh_tokens`, `audit_log`
- Auth: JWT + refresh rotation, RBAC guard, standard error envelope, rate limiting on auth endpoints
- Correlation ID middleware on every service (HTTP + WS)
- Health-check endpoints on every service
- CI: GitHub Actions, lint + unit test + `go test -race` per service on PR
- Base Next.js app with a real login page hitting the real auth API

---

## File/folder structure

```
apps/api/
  src/
    auth/
      auth.controller.ts
      auth.service.ts
      strategies/jwt.strategy.ts
      strategies/jwt-refresh.strategy.ts
      guards/roles.guard.ts
      decorators/roles.decorator.ts
      dto/login.dto.ts, register.dto.ts, refresh.dto.ts
    users/
      users.controller.ts
      users.service.ts
    common/
      filters/all-exceptions.filter.ts      # maps every thrown error to the standard envelope
      interceptors/correlation-id.interceptor.ts
      interceptors/logging.interceptor.ts
      decorators/idempotency-key.decorator.ts
      middleware/rate-limit.middleware.ts
    prisma/
      schema.prisma
      migrations/
    main.ts
  test/
    auth.e2e-spec.ts
  .env.example
  Dockerfile

apps/proctor-gateway/
  cmd/gateway/main.go
  internal/
    ws/hub.go, connection.go              # stub connection accept/reject only, real logic Phase 3
    health/health.go
    middleware/correlation.go
    middleware/recover.go                  # panic recovery — MUST exist before any real logic lands
  go.mod
  Dockerfile

apps/ml-service/
  app/
    main.py                                 # FastAPI app, /health only this phase
    core/config.py                          # pydantic Settings, fails fast on missing env vars
    core/logging.py                          # structured JSON logging setup
    core/correlation.py                       # correlation ID middleware
  requirements.txt
  Dockerfile

apps/judge-worker/
  cmd/worker/main.go                          # stub, real sandbox logic Phase 2
  go.mod
  Dockerfile

apps/web/
  app/
    login/page.tsx
    layout.tsx
    error.tsx                                  # top-level error boundary — required this phase, not deferred
  lib/api-client.ts                             # typed client using packages/shared-types
  package.json

infra/
  docker-compose.yml
  postgres/init.sql (optional seed for local dev)

.github/workflows/
  ci.yml
```

---

## Database schema v1 (Prisma, `apps/api/prisma/schema.prisma`)

```prisma
enum Role {
  STUDENT
  PROCTOR
  ADMIN
}

model User {
  id            String   @id @default(uuid())
  email         String   @unique
  passwordHash  String
  role          Role     @default(STUDENT)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  refreshTokens RefreshToken[]

  @@index([email])
}

model RefreshToken {
  id         String    @id @default(uuid())
  userId     String
  user       User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash  String    @unique   // never store raw token, hash it (SHA-256) same as password approach
  issuedAt   DateTime  @default(now())
  expiresAt  DateTime
  revokedAt  DateTime?
  replacedBy String?              // token rotation chain — set when this token is used to issue a new one

  @@index([userId])
  @@index([tokenHash])
}

model AuditLog {
  id         String   @id @default(uuid())
  actorId    String?              // nullable: system-triggered actions have no actor
  action     String               // e.g. "USER_LOGIN", "REFRESH_TOKEN_REUSE_DETECTED"
  targetType String?
  targetId   String?
  metadata   Json?
  correlationId String?
  createdAt  DateTime @default(now())

  @@index([actorId])
  @@index([action])
  @@index([createdAt])
}
```

**Design notes:**
- `passwordHash`: argon2id (preferred over bcrypt for new systems — better resistance to GPU cracking), never plain bcrypt-only unless the team has no argon2 experience — document the choice either way in `PROJECT_STATUS.md`.
- `RefreshToken.tokenHash` unique + hashed: if the DB is ever leaked, raw refresh tokens aren't sitting in plaintext.
- `replacedBy` chain lets you detect refresh-token reuse: if a revoked token is presented again, that's a signal of theft — log it as `REFRESH_TOKEN_REUSE_DETECTED` in `AuditLog` and revoke the entire token family for that user (force re-login), not just the one token.

---

## Auth flow — full detail

1. **Register** (`POST /v1/auth/register`): email + password, argon2id hash, role defaults to `STUDENT` (admin/proctor accounts created via a seeded/admin-only path, never via public registration — this is a proctoring product, self-service admin signup is a security bug).
2. **Login** (`POST /v1/auth/login`): validates credentials, issues access token (JWT, 15 min, signed with a service-held secret/key) + refresh token (opaque random string, 7 days, hashed before storage).
3. **Access protected route**: `Authorization: Bearer <access_token>`, validated by `JwtStrategy`, `RolesGuard` checks the route's required role(s) against the token's role claim.
4. **Refresh** (`POST /v1/auth/refresh`): presents refresh token → server hashes it, looks up `RefreshToken` row → if valid and not revoked/expired, issues new access+refresh pair, marks old refresh token `revokedAt` + `replacedBy` pointing to the new one → if the presented token is already revoked, this is reuse-detection: revoke the entire chain, log `AuditLog`, return `401 REFRESH_TOKEN_REUSE_DETECTED`.
5. **Logout** (`POST /v1/auth/logout`): revokes the presented refresh token immediately.

**Token claims** (JWT payload): `sub` (userId), `role`, `iat`, `exp`, `correlationId` of the issuing request (useful for tracing a token back to its login event).

---

## Docker Compose details (`infra/docker-compose.yml`)

- `postgres:16` — named volume for data persistence across restarts, healthcheck via `pg_isready`
- `redis:7` — healthcheck via `redis-cli ping`
- `minio/minio` — healthcheck via `mc ready` or `/minio/health/live`, console port exposed for local inspection
- Each app service: `depends_on` with `condition: service_healthy` on its actual dependencies (api depends on postgres+redis healthy, not just "started") — a service starting before its DB is ready is a real Phase 1 bug class, not a hypothetical
- Shared bridge network, service DNS names used in `.env` (`DATABASE_URL=postgresql://...@postgres:5432/...`)
- All services expose `/health` (or `/healthz`) checked by Compose healthcheck directives too, so `docker compose ps` accurately reflects readiness

---

## Edge cases — must be handled and tested this phase

- **Duplicate email registration**: unique constraint violation mapped to a clean `409 EMAIL_ALREADY_EXISTS`, not a raw Prisma error leaking to the client.
- **Login with wrong password N times**: rate-limited/backed-off per `CLAUDE.md` §4.3 — test that the 6th rapid attempt is rejected before hitting the DB.
- **Expired access token on a protected route**: clean `401 TOKEN_EXPIRED`, distinct from `401 INVALID_TOKEN` (malformed/tampered) — frontend behaves differently (silent refresh vs force logout).
- **Refresh token reuse** (see auth flow step 4): explicitly tested — present a revoked token, assert the entire chain is revoked and the user must fully re-login.
- **Concurrent refresh requests with the same token** (e.g., two tabs both refresh at once): only one should succeed and rotate the token; the other must fail cleanly (not both succeed and silently create two divergent token chains) — this needs either a DB-level unique/locking guarantee or explicit test coverage proving it's not racy.
- **Malformed JWT / tampered signature**: rejected at the strategy level before hitting any business logic, standard error envelope, logged at `warn` not `error` (expected adversarial input, not a system fault).
- **Service starts before Postgres/Redis are ready**: Compose healthcheck dependency (above) prevents this in Compose, but each service should also fail fast with a clear log line on DB-connect failure at boot, not hang silently or crash with a raw stack trace.
- **RBAC guard on a route missing an explicit `@Roles()` decorator**: default should be deny-by-default per `CLAUDE.md` §4.2 — test that a route with no explicit role annotation is NOT silently accessible by any authenticated user unless deliberately marked public.
- **Correlation ID missing from an inbound request**: middleware generates one rather than erroring — every log line for that request still has one.

---

## Testing requirements

- **NestJS**: Jest unit tests for `AuthService` (register/login/refresh/logout/reuse-detection logic), `RolesGuard`; e2e test (`test/auth.e2e-spec.ts`) against a real test-container Postgres covering the full register→login→refresh→logout flow plus every edge case above that lives in this service.
- **Go gateway**: `go test ./... -race` on the stub connection accept/reject and correlation ID + panic-recovery middleware — even at stub stage, prove panic recovery works (a test handler that panics should not crash the test process or leave the server unresponsive).
- **Python ml-service**: pytest on config loading (assert it fails fast and clearly on a missing required env var, per `core/config.py` design) and the correlation ID middleware.
- **CI**: every service's test command above runs on every PR; a PR cannot merge with a red service.

---

## Definition of Done

- [ ] `docker compose up` brings up all 5 services + postgres/redis/minio, all healthy, in dependency order
- [ ] Full auth flow works end-to-end: register → login → access protected route → refresh (old token rotated, new one works) → logout (refresh token no longer usable)
- [ ] Refresh-token-reuse detection verified by test: presenting a revoked token revokes the whole chain and is logged to `AuditLog`
- [ ] RBAC guard rejects wrong-role access (test: student hitting an admin-only stub route → `403` in the standard error envelope)
- [ ] Every service returns errors in the standard envelope (`CLAUDE.md` §2.1), not raw framework exceptions
- [ ] Correlation ID present in every log line across a single traced request spanning at least `api` → a stub call into `proctor-gateway`
- [ ] All services respond `200` on `/health`; Compose healthchecks accurately reflect readiness
- [ ] Rate limiting on `/auth/login` and `/auth/refresh` verified by test
- [ ] CI green on a clean PR, including `go test -race`
- [ ] `PROJECT_STATUS.md` updated, Phase 1 row marked done
