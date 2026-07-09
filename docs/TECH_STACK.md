# Tech Stack — AI Olympiad Proctored Exam Platform

**Owner:** Gridixa
**Target load:** 1000 concurrent proctored exam sessions (persistent WebSocket + throttled webcam frame ingestion + integrity events per user)
**Decision date:** 2026-07-09, questions resolved 2026-07-10
**Status:** Locked for Phase 1–6. Any deviation must be logged in `PROJECT_STATUS.md`'s Key Decisions Log with a reason.

---

## 1. Architecture overview

```
                         ┌─────────────────────┐
                         │      apps/web        │  Next.js — candidate portal + admin/proctor dashboard
                         └──────────┬───────────┘
                                    │ REST (exam CRUD, auth, results)
                                    │ WS (proctoring stream)
              ┌─────────────────────┼─────────────────────────┐
              ▼                                                ▼
     ┌─────────────────┐                             ┌───────────────────────┐
     │    apps/api       │  NestJS — core API           │  apps/proctor-gateway   │  Go — WS gateway
     │  auth/exams/       │◄────internal REST──────────►│  frame + event ingest    │
     │  questions/sessions │  (presence, token verify)   │  throttle, presence       │
     └─────────┬──────────┘                             └───────────┬─────────────┘
               │                                                     │ XADD
               │ Redis (queue: submissions)                          ▼
               ▼                                          ┌───────────────────┐
     ┌───────────────────┐                                │   Redis Streams     │  proctor:frames, proctor:events
     │  apps/judge-worker   │  Go — sandboxed code exec       │  (+ pub/sub alerts)  │
     │  Docker-per-submission │                              └──────────┬─────────┘
     └───────────────────┘                                             │ XREADGROUP
                                                                        ▼
                                                             ┌───────────────────┐
                                                             │   apps/ml-service    │  Python/FastAPI
                                                             │  face/gaze/object      │
                                                             │  detection, flagging    │
                                                             └──────────┬─────────┘
                                                                        │
                                                              ┌─────────┴─────────┐
                                                              ▼                   ▼
                                                        PostgreSQL            MinIO (flagged
                                                     (ProctorFlag rows)       frames only)
```

All services share: PostgreSQL (system of record), Redis (queue + pub/sub + cache), structured JSON logging with correlation ID propagation, Prometheus metrics from Phase 5 onward.

---

## 2. Why a polyglot architecture (not one language for everything)

The workload has three fundamentally different performance profiles. Forcing them onto one runtime always costs you somewhere:

| Concern | Profile | What breaks with the wrong runtime |
|---|---|---|
| CRUD, auth, exam/question management, results | Low concurrency, I/O-bound, business-logic-heavy, changes often | Nothing breaks technically in most languages — the real risk here is *dev velocity and maintainability* as rules accumulate (RBAC, audit logging, state machines) |
| 1000 persistent WebSocket connections + constant frame/event trickle | Extreme *connection count*, low CPU per connection but constant background work | Node's single event loop and Python's GIL both degrade once you add real CPU work (validation, throttling, encoding) on top of holding sockets open — spiky p99 latency under load |
| CV/ML inference on frames (face, gaze, object detection) | Bursty CPU/GPU-bound work, model-library dependent | No language other than Python has a comparably mature CV/ML ecosystem (MediaPipe, ONNX Runtime, OpenCV) — building this in Go or Node means either FFI pain or reimplementing detection logic with far less mature tooling |

Splitting by workload also maps directly onto independent horizontal scaling (Phase 5's custom-metric HPA design): 20 ML-service replicas scaling on consumer lag and 3 API replicas scaling on CPU never have to compromise on the same autoscaling policy. This also directly serves the resume goal — it demonstrates distributed systems design and service-boundary reasoning, the exact keyword gap flagged as open (ML infrastructure, distributed systems).

**Alternative rejected: single-language monolith (all Node, or all Python, or all Go).** Rejected because the performance-profile mismatch above is real, not theoretical, at the 1000-concurrent target — and because a monolith here would need a full rewrite of whichever piece turned out to be the bottleneck, rather than an independent service swap.

---

## 3. Core Services — full detail

### 3.1 `apps/web` — Candidate Portal + Admin/Proctor Dashboard

| Layer | Choice | Version/notes |
|---|---|---|
| Framework | Next.js | 15.x, App Router |
| Language | TypeScript | strict mode on |
| Styling | Tailwind CSS + shadcn/ui | component primitives, not a full design system dependency |
| Code editor (coding questions) | Monaco Editor | same engine as VS Code, familiar to candidates |
| WS client | native `WebSocket` API, thin wrapper with reconnect/backoff | no heavyweight client library needed for this scope |
| State | React state + Server Components where reasonable | no Redux/Zustand unless a real cross-cutting state need emerges during build — don't add it speculatively |

**Why Next.js specifically:** SSR is genuinely useful for the admin dashboard (data-heavy, benefits from server-rendered initial state), and App Router's route groups cleanly separate the two very different UIs (candidate exam-taking vs admin/proctor monitoring) inside one deployable app rather than maintaining two separate frontend projects.

**Why not a plain Vite SPA:** would work functionally, but loses SSR for the admin dashboard and requires hand-rolling routing conventions Next.js already provides — not worth it for a two-audience app like this.

### 3.2 `apps/api` — Core API

| Layer | Choice | Version/notes |
|---|---|---|
| Framework | NestJS | 10.x |
| Language | TypeScript | strict mode |
| ORM | Prisma | migrations + generated types feed `packages/shared-types` |
| Validation | `class-validator` + `class-transformer` | DTOs reject unknown fields (`forbidNonWhitelisted: true`) |
| Auth | Passport strategies (`passport-jwt`) wrapped in Nest guards | access + refresh, see Phase 1 doc for full flow |
| Password hashing | argon2id | via `argon2` npm package — chosen over bcrypt for better resistance to GPU-based cracking on a system holding student PII |

**Why NestJS over plain Express/Fastify:** this service accumulates business rules fast (RBAC, audit logging, server-enforced exam timers, submission validation, idempotency handling). NestJS's DI and module system keep that maintainable for a small team; guards/interceptors map directly onto cross-cutting concerns like the correlation-ID and standard-error-envelope conventions in `CLAUDE.md`.

**Why Prisma over TypeORM:** better migration ergonomics (declarative schema, generated migration SQL reviewable in PR), and the generated client's types are the direct source for `packages/shared-types`, keeping frontend/backend contracts in sync without a separate codegen step.

**Rejected alternative: tRPC instead of REST.** Would tighten the TS-only frontend/backend contract further, but `proctor-gateway` (Go) and `ml-service` (Python) can't participate in a tRPC contract anyway, so the project would end up maintaining two contract systems (tRPC for web↔api, REST/protobuf for everything else) instead of one consistent REST+shared-types approach across the board.

### 3.3 `apps/proctor-gateway` — Realtime Proctoring Gateway

| Layer | Choice | Version/notes |
|---|---|---|
| Language | Go | 1.22+ |
| HTTP framework | Fiber | fast, familiar Express-like API, good WS support |
| WebSocket | `gorilla/websocket` | the de facto standard, well-understood connection-pump pattern |
| Logging | `zerolog` | structured JSON, low allocation overhead — matters at 1000 concurrent connections logging per-message |
| Redis client | `go-redis/v9` | Streams (XADD/XREADGROUP) support |

**Why Go specifically:** this is the one service where "1000 concurrent" is a literal, load-bearing requirement. Goroutines cost roughly 2KB of stack each and the Go scheduler is built precisely for thousands of mostly-idle, occasionally-active connections. A Node.js gateway *can* hold 1000 sockets, but adding real CPU work per frame (throttle checks, validation) on the same event loop introduces latency spikes under load that Go's true parallelism avoids.

**Why Fiber over `net/http` + Gorilla directly, or Gin/Echo:** Fiber's performance profile and ergonomics are comparable to Gin/Echo; the choice here is not load-bearing — any of the three would work. Fiber is picked for familiarity/ecosystem fit with the rest of the stack's Express-like conventions in `apps/api`. If the team has a strong existing preference for Gin or Echo, that's a low-risk swap — document the change in `PROJECT_STATUS.md` if made.

**Rejected alternative: Node.js for the gateway too (one less language).** Rejected per §2 — the performance profile genuinely differs from `apps/api`'s CRUD workload, and this is precisely the component where that difference matters most.

### 3.4 `apps/ml-service` — ML Flagging Service

| Layer | Choice | Version/notes |
|---|---|---|
| Language | Python | 3.12 |
| Framework | FastAPI | async, good fit for I/O-bound consumer loop wrapping CPU-bound detector calls |
| Face/gaze detection | MediaPipe (Face Mesh) | Google's pretrained face landmark model, no custom training needed for v1 |
| Object detection | ONNX Runtime + a lightweight pretrained/fine-tuned model (e.g. distilled YOLO variant) | ONNX chosen for portability/runtime speed over a full PyTorch inference dependency |
| Image handling | OpenCV (`opencv-python-headless`) | headless variant — no GUI dependencies needed in a container |
| Redis client | `redis-py` (asyncio) | Streams consumer group support |
| Validation | Pydantic v2 | config loading (`core/config.py`) and internal API schemas |

**Why Python here specifically (not elsewhere):** this is the only service where ecosystem maturity matters more than raw throughput. MediaPipe and ONNX Runtime are Python/C++-native tooling with no comparably mature equivalent in Go or Node — reimplementing face-mesh detection from scratch to avoid Python would be a significant, unjustified engineering cost.

**Why ONNX Runtime over a raw PyTorch/TensorFlow serving setup:** smaller container footprint, faster inference for a single lightweight model, no need for a full training-framework runtime in production — ONNX is specifically an inference-time optimization, appropriate here since no on-the-fly training happens in this service.

**Rejected alternative: a third-party cloud vision API (e.g. a hosted face-detection API) instead of self-hosted MediaPipe/ONNX.** Rejected for the same reason a third-party proctoring SaaS was rejected — per-request cost at 1000-concurrent scale with continuous frame checks would be significant, plus it reintroduces the vendor-lock-in/data-leaves-the-building concern for sensitive biometric data that self-hosting avoids.

### 3.5 `apps/judge-worker` — Code Execution Sandbox

| Layer | Choice | Version/notes |
|---|---|---|
| Language | Go | orchestrator; matches gateway for consistency in the "systems" half of the stack |
| Isolation | Docker containers, gVisor runtime if available in the target environment, else strict cgroup limits | `--network none`, capped CPU/mem/pids, size-capped read-only-root + tmpfs |
| Docker control | Docker Engine API via the official Go SDK | container lifecycle, resource limits, forced cleanup |
| Supported languages v1 | Python, JavaScript (Node), Java, C++ | matches typical olympiad language expectations; extensible via the `LanguageRunner` interface (Phase 2 doc) |

**Why not a SaaS code-judge API (e.g. Judge0-as-a-service):** company product, avoids per-execution vendor cost and lock-in at 1000-concurrent scale; also a stronger, more specific resume line (sandboxed execution design, resource isolation, adversarial-input hardening) than "integrated a third-party judge API."

**Why Go for the orchestrator specifically:** container lifecycle management benefits from the same concurrency model as the gateway (many workers pulling from a queue, spinning/tearing down containers) — reuses team familiarity built from `proctor-gateway` rather than introducing a fourth language.

---

## 4. Data & Infra Layer — full detail

| Component | Choice | Version | Why |
|---|---|---|---|
| Primary DB | PostgreSQL | 16 | Relational integrity for users/exams/results/flags/consent records; matches existing Quant Platform experience (SQLAlchemy 2.0/Alembic there, Prisma here — same relational-modeling instincts transfer) |
| Cache / pub-sub / queue | Redis | 7.x, Streams for queues, Pub/Sub for live alerts | One piece of infra covers three needs at this scale — queueing (frames, events, submission jobs), caching (rate-limit counters, gaze sliding windows), and live alert fan-out — without the ops overhead of separate systems for each |
| Object storage | MinIO | self-hosted, S3-compatible API | Flagged-frame snapshots only, low volume given no continuous recording; S3-API-compatible means a swap to real AWS S3 later (if hosting target moves to AWS) requires no application code changes, only config |
| Reverse proxy / ingress | Traefik (or Nginx — decide based on final hosting target) | — | TLS termination, WebSocket-aware routing (correct upgrade headers/timeouts) to the gateway |
| Containerization | Docker Compose (dev) → Kubernetes (prod, Phase 5) | — | Start simple in local dev, scale-out only once Phase 5's load test proves the need and defines the actual resource requirements |
| CI/CD | GitHub Actions | — | Matches existing Airflow/Magpie contribution workflow familiarity |
| Observability | Prometheus + Grafana + Loki + OpenTelemetry | — | Needed to actually validate the "1000 concurrent" claim with evidence, not just assert it — see Phase 5 doc for exact metrics per service |
| Load testing | k6 | — | Native WebSocket + HTTP scenario support in one tool, scriptable thresholds |

### Why Redis Streams over Kafka at launch

Redis Streams provides consumer groups, at-least-once delivery, and pending-entry reclaim (`XAUTOCLAIM`) — everything Phase 4's ML consumer pipeline needs — without the operational overhead of running and tuning a Kafka cluster. At 1000 concurrent sessions, the message volume (throttled frames every ~2s + occasional events per session) is well within Redis Streams' comfortable range. Kafka becomes worth the added ops cost if message volume grows an order of magnitude, if durability guarantees stronger than Redis's persistence model are required, or if multiple independent consumer applications beyond `ml-service` need the same stream — none of which is true for v1. **This is a documented upgrade path, not a permanent decision** — if Phase 5's load test reveals Redis Streams struggling, Kafka migration is the next step, and this section should be updated with the actual measured reason if that happens.

### Why MinIO self-hosted over managed cloud object storage at launch

Low frame-storage volume (flagged frames only) doesn't justify managed S3 cost at launch, and self-hosting keeps sensitive biometric data on infrastructure Gridixa fully controls rather than a third-party managed service, which simplifies the Phase 6 DPDP compliance story. The S3-compatible API means this is a low-friction swap later if Gridixa's hosting strategy moves toward a specific cloud provider's managed offering — no application code changes, only a config/credentials swap.

---

## 5. Cross-service contracts

| Link | Protocol | Defined in |
|---|---|---|
| `apps/web` ↔ `apps/api` | REST (versioned `/v1/...`) | `packages/shared-types` (Prisma-generated types + OpenAPI) |
| `apps/web` ↔ `apps/proctor-gateway` | WebSocket (binary framed protocol, see Phase 3 doc) | `apps/proctor-gateway/internal/protocol` |
| `apps/api` ↔ `apps/proctor-gateway` | Internal REST (session token issuance, presence queries) | `packages/shared-types` |
| `apps/proctor-gateway` ↔ Redis Streams ↔ `apps/ml-service` | Redis Streams message fields (not gRPC — simpler given Redis is already the transport, avoids adding a second protocol layer for this hop) | Documented field schemas in Phase 3/4 docs |
| `apps/api` ↔ `apps/judge-worker` | Redis queue job schema (JSON) | Documented in Phase 2 doc |
| All services | Correlation ID propagation (HTTP header / Redis Stream field / WS message field) | `CLAUDE.md` §4.5 |

**Note on `packages/proto`:** originally scoped for gRPC between the gateway and ML service; superseded by the Redis Streams-native field schema decision above, since introducing gRPC alongside Redis Streams for the same hop would be redundant complexity. Keep `packages/proto` in the repo layout only if a future direct (non-queued) synchronous call between gateway and ML service becomes necessary — not needed for the v1 design.

---

## 6. Explicitly rejected / deferred options (summary)

| Option | Status | Reason |
|---|---|---|
| Kafka at launch | Deferred | Redis Streams sufficient at 1000-concurrent; documented upgrade path if Phase 5 load testing says otherwise |
| Managed proctoring SaaS | Rejected | Company wants to own the product; this is explicitly a build-to-ship + resume project |
| Full video recording/storage | Rejected | Explicit product/privacy decision — flagged frames only |
| Single-language monolith | Rejected | Workload performance-profile mismatch, see §2 |
| Third-party cloud vision API for detection | Rejected | Cost at scale + biometric-data vendor exposure |
| SaaS code-judge API | Rejected | Cost at scale + weaker resume signal than owning sandboxing |
| tRPC instead of REST | Rejected | Doesn't extend to the Go/Python services; would fragment the contract story |
| gRPC between gateway and ML service | Deferred | Redis Streams-native field schema is sufficient; gRPC adds a redundant protocol layer for this specific hop |
| Managed cloud object storage at launch | Deferred | Low volume doesn't justify cost yet; S3-API compatibility keeps the door open |

---

## 7. Scaling characteristics summary (informs Phase 5's HPA design)

| Service | Bottleneck resource | Scales on (custom metric) | Stateless? |
|---|---|---|---|
| `apps/api` | CPU/memory, DB connection pool | CPU/memory (standard) | Yes |
| `apps/proctor-gateway` | Open connection count, per-connection memory | Active WS connection count | Yes (no session affinity required — see Phase 5 doc) |
| `apps/ml-service` | CPU (inference), Redis consumer lag | Redis Streams consumer lag | Yes |
| `apps/judge-worker` | Docker daemon capacity, queue depth | Redis queue depth | Yes |
| `apps/web` | Request volume (mostly SSR render cost) | CPU/memory (standard) | Yes |
| PostgreSQL | Connection count, write throughput | Not horizontally scaled in v1 — vertical sizing informed by Phase 5 load test; read replicas are a documented future option if read load justifies it | No (stateful) |
| Redis | Memory, ops/sec | Not horizontally scaled in v1 (single instance/cluster sized from load test); Redis Cluster is a documented future option | No (stateful) |
| MinIO | Storage volume, throughput | Not a v1 concern given low flagged-frame volume | No (stateful) |

---

## 8. Versioning & compatibility policy

- API versioned at the URI level (`/v1/...`) from day one, per `CLAUDE.md` §4.1.
- Database migrations follow an expand-then-contract pattern across deploys during any rolling-deploy window, per Phase 5's migration policy — never a single breaking schema change deployed alongside code that depends on it in the same rollout.
- Docker images pinned to specific digests (not floating `latest` tags) for anything security-sensitive, especially `judge-worker`'s per-language execution images (Phase 2 doc) — floating tags on execution sandboxes are a supply-chain risk.
- Dependency versions pinned (lockfiles committed: `package-lock.json`, `go.sum`, `requirements.txt` with hashes or a `poetry.lock`) — reproducible builds across dev/CI/prod.
