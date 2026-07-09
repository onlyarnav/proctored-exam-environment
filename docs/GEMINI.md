# CLAUDE.md — AI Olympiad Proctored Exam Platform

This file is read by Claude Code at the start of every session in this repo. It is the source of truth for conventions — if code and this file disagree, fix the code (or update this file with a reason, don't silently drift).

## What this project is

A proctored online exam platform for an AI Olympiad, built for Gridixa, production deployment target, supporting 1000 concurrent proctored exam sessions. MCQ + coding questions. Server-side ML flagging (face/gaze/object detection), tab-switch + copy-paste detection, live webcam checks — no video recording or storage, flagged frames only. Standalone auth (no Gridixa SSO for v1).

**Always read `PROJECT_STATUS.md` first** — it tells you the active phase, resolved/open decisions, and what's already built. Don't re-derive decisions that are already logged there.

Reference docs: `docs/TECH_STACK.md` (why each technology), `docs/PHASE_1..6_*.md` (what to build, in what order, with Definition of Done per phase), `docs/CLAUDE_CODE_SKILLS.md` (custom skills to build).

## Repo layout

```
apps/
  web/                 Next.js — candidate portal + admin/proctor dashboard
  api/                 NestJS — core API (auth, exams, questions, results)
  proctor-gateway/     Go — WebSocket gateway, frame/event ingestion
  ml-service/          Python/FastAPI — face/gaze/object detection flagging
  judge-worker/        Go orchestrator — sandboxed code execution
packages/
  shared-types/        Shared TS types / OpenAPI-generated client
  proto/               protobuf defs for gateway <-> ml-service
infra/
  docker-compose.yml   Local dev stack
  k8s/                 Production manifests (Phase 5)
docs/                  Phase plans, tech stack, architecture decisions
```

---

## 1. Non-negotiable principles

1. **No fabricated metrics, test results, or benchmark numbers.** If a number isn't measured, write `[MEASURE: description]` — never invent latency/throughput/accuracy figures anywhere: docs, comments, commit messages, PR descriptions.
2. **One phase at a time.** Don't start Phase N+1 until Phase N's Definition of Done (in its phase doc) is met and `PROJECT_STATUS.md` reflects it.
3. **Every service has real tests**, not just happy-path smoke tests — see §5 per-service testing requirements and §4 edge case catalog. A service isn't "done" without both.
4. **Strategy pattern / interface-first for anything with multiple implementations or future implementations** — language runners in `judge-worker`, detectors in `ml-service`, storage backends, auth providers. Mirrors the existing SparkSubmitOperator refactor pattern. Don't hardcode a single implementation where a second is plausible.
5. **No full video recording, ever.** Only single flagged frames may be persisted. This is a product/privacy decision, not a technical one — enforce it in code review, not just docs. Any PR that introduces continuous frame/video storage should be rejected regardless of justification.
6. **Structured JSON logging only** in service code — no bare `console.log`/`print`/`fmt.Println` outside local one-off debug scripts. Every log line in a request/session context must include a correlation ID (see §6).
7. **Server is the source of truth, never the client** — exam timers, submission deadlines, proctoring flag decisions, tab-switch/copy-paste counts. The client only reports raw signals; it never computes or self-reports a verdict. This is both a security requirement (candidates can tamper with client JS) and a product requirement (proctoring integrity).
8. **Idempotency on all state-changing endpoints that can plausibly be retried** — submission endpoints, session-start, payment/grading triggers (once they exist). See §4.4.
9. **Commits:** conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`), scoped per service where possible (`feat(gateway): ...`).
10. **Secrets never committed.** `.env.example` per service documents every required var with a comment on what it's for; real `.env` gitignored. Rotate any secret that touches a PR by mistake — don't just remove it from a later commit.

---

## 2. Error handling philosophy (applies across all services)

### 2.1 Standard error envelope

Every HTTP/API error response (NestJS and internal endpoints on Go/Python services) uses the same shape:

```json
{
  "error": {
    "code": "SESSION_ALREADY_SUBMITTED",
    "message": "Human-readable, safe to show to a non-technical admin",
    "correlationId": "req_9f2a...",
    "details": { "sessionId": "...", "submittedAt": "..." }
  }
}
```

- `code` is a stable, machine-checkable string (SCREAMING_SNAKE_CASE), not an HTTP status alone — frontends branch on `code`, not on message text.
- `message` is never a raw exception string or stack trace leaked to the client.
- `details` is optional, structured, safe-to-log context — never include secrets, tokens, or full request bodies.
- Maintain the error code taxonomy in `packages/shared-types/errors.ts` (or equivalent) as the single source both API and frontend import from — don't let error strings drift between services.

### 2.2 Retryable vs non-retryable

Every error must be classifiable as one or the other, and clients (including internal service-to-service calls) must respect it:

- **Retryable** (network blips, 503s, Redis transient unavailability, DB connection pool exhaustion): exponential backoff with jitter, capped retry count, circuit breaker if a downstream is consistently failing (don't hammer a dead Redis for 1000 concurrent sessions simultaneously).
- **Non-retryable** (validation errors, 403/404, business-rule violations like "exam already submitted"): fail fast, surface to the user/caller immediately, no retry loop.

### 2.3 Never swallow errors

- No empty `catch {}` / `except: pass` / ignored Go error returns (`_ = err` is a code-review red flag unless commented with an explicit reason it's safe to ignore).
- Every caught error either: recovers and logs at `warn`, or re-throws/propagates with added context, or logs at `error` and triggers an alert path (see §7). Never just disappear.
- Go: check every error return explicitly; don't rely on panics for expected failure paths (bad input, network errors) — panics are for programmer bugs only, and every service must have panic-recovery middleware so one bad request can't take down 999 other concurrent sessions' connections.

### 2.4 Partial failure is the default assumption, not the exception

At 1000 concurrent sessions, "everything succeeds" is the rare case. Design every cross-service interaction assuming the downstream might be slow, down, or return garbage:

- Frame ingestion → Redis Streams: if Redis is down, the gateway must degrade gracefully (buffer briefly with a hard cap, then drop frames and flag "proctoring degraded" for that session — never crash the WS connection or fail the exam because telemetry couldn't be written).
- ML service → MinIO: if MinIO is unavailable when trying to persist a flagged frame, retry with backoff, and if still failing, write the flag row to Postgres with `frameUrl: null` and a `storageFailed: true` marker rather than dropping the flag entirely — a flag without a frame is still useful to a reviewer; a silently dropped flag is a proctoring gap.
- `apps/api` → `judge-worker` queue: if Redis (queue) is unavailable at submission time, the submission must still be durably recorded in Postgres with status `QUEUE_FAILED`, with a reconciliation job that re-enqueues stuck submissions — a candidate's code submission must never be silently lost.

---

## 3. Edge case catalog (must be handled, must have a test where noted)

### 3.1 Exam session / timing edge cases
- **Submit exactly at `endsAt`**: server-side check must use `<=` consistently and be tested at the exact boundary — off-by-one here either unfairly fails a legitimate last-second submit or allows a late one.
- **Client clock skew**: countdown timer displayed to candidate is client-rendered from a server-provided `endsAt`, but every submit/state-transition call is validated against server time, never trusts a client-sent timestamp.
- **Browser refresh/crash mid-exam**: session state and answers-so-far must be recoverable from server state on reconnect — candidate should never lose progress because of a tab crash. Autosave answers on every change, not just on final submit.
- **Duplicate tab / same candidate opens exam in two tabs**: define and enforce single-active-session-per-candidate-per-exam (second tab either blocks with a clear message, or invalidates the first — pick one, document the choice in `PROJECT_STATUS.md` decisions log, and test it).
- **Network drop and reconnect mid-exam**: distinguished from "candidate closed the browser" — grace period logic in the gateway (see Phase 3 doc) must not falsely flag a brief drop as abandonment, but must flag genuine abandonment after the grace period.
- **Exam edited by admin while sessions are in progress** (e.g., a question's points changed): decide and document whether in-progress sessions see the old or new version — recommended default: snapshot exam+questions at session start, admin edits only affect future sessions. Must be an explicit decision, not accidental behavior.
- **Duplicate submission** (double-click submit, retried network request): submission endpoint must be idempotent (see §4.4) — must not create two `Submission` rows or double-run the judge for the same answer.

### 3.2 Proctoring edge cases
- **Webcam permission denied or revoked mid-exam**: must be detected (not just at start) and surfaced as a distinct flag type from "no face detected" — a candidate who denies camera access is a different signal than one whose camera briefly loses the face.
- **Poor lighting / low-quality webcam causing false no-face flags**: document the detector's confidence threshold and debounce window (Phase 4 doc); this is a tuning problem, not a bug, but must be tracked as a known false-positive source, not silently accepted as "working as intended" without review data.
- **Virtual camera / video-spoofing tools**: out of scope to fully defeat in v1 — document this explicitly as a known limitation in the Phase 6 handover doc, don't silently pretend the system is spoof-proof.
- **Multiple browser tabs each trying to open a proctoring WS connection**: gateway must reject/close a second connection for the same session, not silently multiplex two frame streams for one candidate.
- **Frames arriving faster than the throttle interval** (buggy or tampered client): server-side rate limiting on frame ingestion per session, independent of client-side throttling — never trust the client to self-throttle.
- **Tab-switch/copy-paste event flood** (e.g., a script hammering the events): rate-limit and cap counted events per time window so one runaway script doesn't spam Redis/Postgres or trigger absurd flag counts.

### 3.3 Code execution (judge-worker) edge cases
- **Infinite loop**: hard wall-clock timeout, `SIGKILL` on breach, container removed even if the kill itself errors (use `defer`/cleanup that runs regardless of how the function exits).
- **Fork bomb / resource exhaustion attempt**: process count limits (`--pids-limit`) in addition to CPU/memory caps.
- **Network exfiltration attempt**: `--network none` on the execution container, no exceptions — test this explicitly (submit code that tries to make an HTTP request, assert it fails).
- **Disk-fill attempt** (writing huge files): capped writable filesystem size (`--tmpfs` with size limit or read-only root + small tmpfs).
- **Huge stdout/stderr** (e.g., an infinite print loop that would OOM the collecting process before the timeout even hits): truncate captured output at a fixed byte limit, don't buffer unbounded.
- **Unsupported language or malformed submission**: reject before even attempting to spin a container — validate language against the supported set and basic payload sanity first.
- **Container fails to start at all** (Docker daemon issue, image pull failure): this is a system fault, not a candidate fault — must not silently record it as a failing submission; retry or surface as `JUDGE_UNAVAILABLE`, never as a wrong-answer score.
- **Concurrent submissions from the same candidate for the same question** (double-submit): same idempotency requirement as §3.1.

### 3.4 Concurrency / race condition edge cases
- **Two workers picking up the same queued job** (at-least-once delivery from Redis Streams consumer groups): every consumer (ml-service, judge-worker) must be idempotent on job processing — dedupe by a stable job/frame ID, don't assume exactly-once delivery.
- **Session state transition races** (e.g., auto-submit-on-timeout firing at the same moment as a manual submit): use a DB-level constraint or transaction with row locking on the session state transition, not an application-level "check then write" that can race.
- **Admin reviewing/dismissing a flag at the same moment the retention job tries to delete it**: retention job must skip flags with a pending review action, or the review action must fail gracefully if the flag was already purged — decide and document which wins.

### 3.5 Infrastructure edge cases
- **Redis unavailable**: see §2.4 — gateway degrades, doesn't crash; API queue writes fail safe to Postgres-recorded pending state.
- **Postgres connection pool exhaustion at 1000 concurrent sessions**: connection pool sized deliberately (not left at ORM default), and the failure mode when exhausted is a clear 503/backpressure, not a slow cascading timeout across all services.
- **MinIO unavailable**: see §2.4.
- **Service restart / deploy mid-exam**: rolling deploys must not drop active WebSocket connections all at once — document the reconnect behavior candidates will see during a deploy (should look like the "brief network drop" case in §3.1, not a failed exam).
- **Clock drift between services**: all services should sync to NTP; any cross-service timestamp comparison (e.g., "frame is stale") should tolerate a small skew window, not assume perfectly synced clocks.

---

## 4. Cross-cutting technical conventions

### 4.1 API design (NestJS)
- URI versioning: `/v1/...` from day one, even with only one version — avoids a painful retrofit.
- Pagination: cursor-based for any list endpoint that can grow unbounded (submissions, audit log, flags) — offset pagination is acceptable only for small, bounded admin lists (e.g., exam list).
- All request bodies validated via DTOs + `class-validator`; reject unknown fields (`forbidNonWhitelisted: true`) rather than silently ignoring typos in client payloads.
- All timestamps stored and transmitted as UTC ISO 8601; timezone display conversion is a frontend concern only.

### 4.2 Authentication & authorization
- Access token 15 min, refresh token 7 days, refresh rotation (old refresh token invalidated on use) — detect and alert on refresh-token reuse (signal of a stolen token).
- RBAC enforced via guard on every route by default (deny-by-default), explicit opt-out only for public routes (health checks, login).
- WS connections in `proctor-gateway` authenticate via short-lived, single-purpose token issued by `apps/api` at session start — not the general-purpose access token, so a leaked WS token has minimal blast radius.

### 4.3 Rate limiting
- `/auth/login`, `/auth/refresh`: per-IP and per-account rate limits, with account lockout/backoff on repeated failures (protect against credential stuffing on a student-data platform).
- Frame/event ingestion on the gateway: per-session rate limit independent of the WS-level throttle (§3.2).
- Public-facing admin endpoints: standard rate limiting to protect against scraping/abuse.

### 4.4 Idempotency
- Any endpoint that mutates state and could plausibly be retried (client timeout-and-retry, double-click, network blip) accepts an `Idempotency-Key` header; server stores recent keys with their response and replays the same response for a repeat, rather than reprocessing.
- Minimum coverage: exam session submit, code submission, session start.

### 4.5 Correlation IDs / tracing
- Every incoming request/WS connection gets a correlation ID (generate if not provided by an upstream), propagated through every log line and every downstream call (HTTP header, gRPC metadata, or Redis Streams message field) across NestJS → Go gateway → Redis → ML service.
- OpenTelemetry trace context propagated the same way from Phase 5 onward — correlation IDs should map cleanly onto trace IDs, not be a separate ad hoc system.

### 4.6 Testing requirements per service
- **NestJS**: Jest unit tests per module/service; integration tests against a real (test-container) Postgres, not mocked ORM calls, for anything touching transactions or constraints; explicit tests for every edge case in §3.1 that lives in this service.
- **Go (gateway, judge-worker)**: standard `testing` + `testify`; goroutine leak checks in tests that spin connections/workers (`goleak` or equivalent); explicit tests for §3.3 malicious-code scenarios and §3.2 rate-limit/reject-second-connection scenarios.
- **Python (ml-service)**: pytest; detector unit tests against fixture frames (staged known-good/known-bad images, not just synthetic noise); consumer group tests covering at-least-once/dedupe behavior from §3.4.
- **Cross-service**: integration/e2e tests for the full exam flow (Phase 2) and full proctoring flow (Phase 3–4) belong in a dedicated `e2e/` suite run against `docker compose`, not left as "tested manually once."

---

## 5. Logging & observability conventions
- JSON structured logs everywhere; minimum fields on every log line in a request/session context: `timestamp`, `level`, `service`, `correlationId`, `sessionId` (if applicable), `message`.
- Log levels used with intent: `debug` (dev only, verbose), `info` (normal operation milestones — session started, submission graded), `warn` (recovered error, degraded mode, retry happening), `error` (unrecovered, needs attention), never use `error` for expected business-rule rejections (e.g., "exam already submitted" is a 4xx, not an error log).
- Every `error`-level log must include enough context to reproduce/investigate without needing to go find the request — don't log a bare exception message.
- From Phase 5 onward: every service exposes Prometheus metrics (`/metrics`), see `docs/PHASE_5_SCALE_DEPLOY.md` for the specific custom metrics required (connection count, consumer lag, queue depth).

---

## 6. Security conventions (beyond auth/rate-limiting above)
- Input validation at every trust boundary, not just at the edge — a service receiving data from another internal service still validates it (defense in depth, especially relevant for gateway → ML service frame data).
- WS `Origin` header checked on upgrade, not left open to any origin.
- Dependency vulnerability scanning in CI from Phase 5 (`npm audit`, `govulncheck`, `pip-audit`), high-severity findings block merge.
- No PII/biometric data (webcam frames, face landmarks) in logs, ever — log metadata (session ID, flag type, confidence score), never the frame bytes or raw landmark coordinates.
- Sandboxed code execution security requirements are in §3.3 — treat every submission as actively malicious by default, not just buggy.

---

## 7. Alerting / incident-path awareness
- Any `error`-level log or failed health check in a service that's part of the live-exam critical path (gateway, api, judge-worker, ml-service, Postgres, Redis) should be wired to an alert from Phase 5 onward — see `docs/PHASE_5_SCALE_DEPLOY.md` and `docs/PHASE_6_COMPLIANCE_HANDOVER.md` for the specific runbooks (ML misflag storm, gateway connection drop, sandbox escape suspicion).
- When implementing error handling, always ask "if this fires at 2am during a live 1000-candidate exam, is there a clear next action in a runbook?" — if not, that's a gap to flag, not just handle-and-move-on.

---

## 8. Commands (fill in as each service is scaffolded in Phase 1)

```bash
# Full local stack
docker compose -f infra/docker-compose.yml up

# api (NestJS)
cd apps/api && npm run dev / npm run test / npm run test:e2e / npm run lint

# proctor-gateway (Go)
cd apps/proctor-gateway && go run ./cmd/gateway && go test ./... -race

# judge-worker (Go)
cd apps/judge-worker && go run ./cmd/worker && go test ./... -race

# ml-service (Python)
cd apps/ml-service && uvicorn app.main:app --reload && pytest

# web (Next.js)
cd apps/web && npm run dev

# load test (Phase 5)
k6 run infra/loadtest/exam_session.js
```

Note `-race` on Go test runs — required given the concurrency-heavy nature of the gateway and judge-worker; a green test suite without `-race` is not sufficient evidence of correctness here.

## 9. When implementing a phase
1. Open the relevant `docs/PHASE_N_*.md` — full task breakdown, file structure, Definition of Done.
2. Cross-reference this file's §2–§7 for error handling, edge cases, and conventions relevant to whatever you're building — the phase docs describe *what*, this file describes *how*.
3. Update `PROJECT_STATUS.md` checkboxes as tasks complete, not batched at the end.
4. Don't mark a phase complete until its Definition of Done is fully met, including the edge-case tests called out in §3 that apply to that phase's scope.

## 10. Known constraints to respect
- Target: 1000 concurrent proctored sessions — every design decision in gateway/ML services made with this number in mind.
- No third-party proctoring SaaS — build-to-own product.
- Redis Streams is the default queue; don't introduce Kafka without a documented reason in `docs/TECH_STACK.md`'s upgrade-path section.
- Standalone auth for v1 — no Gridixa SSO, but auth module stays behind an interface for a future OIDC bridge.
- MCQ + coding both in scope from Phase 2 — `judge-worker` is not optional/deferred.
