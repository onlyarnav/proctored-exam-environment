# Phase 5 — Scale Validation, Deployment & Observability

**Goal:** Prove — with real measured numbers, not projections — that the platform holds 1000 concurrent proctored sessions under realistic load, then ship it to production for Gridixa with monitoring, alerting, autoscaling, and a documented deployment/rollback process.

---

## Scope

- Full-stack load test simulating 1000 concurrent candidates through the entire flow
- Horizontal scaling validated for every stateless service; explicit confirmation the gateway does NOT require sticky sessions in a way that breaks scaling
- Kubernetes manifests with resource requests/limits, health probes, PodDisruptionBudgets, HPA on custom metrics
- Observability: Prometheus metrics, Grafana dashboards, Loki logs, OpenTelemetry traces across the frame pipeline
- Security hardening pass with dependency scanning in CI
- Production deployment runbook + rollback plan

---

## Load test design — full detail

### Scenario 1: Full exam simulation at 1000 concurrent

- **Ramp pattern**: not a instantaneous spike — stagger virtual candidates joining over a configurable window (e.g. 1000 candidates over 5–10 minutes) to mirror a real exam's staggered login pattern, then hold steady state for the mock exam's full duration, then a coordinated ramp-down (mirroring mass logout/submission near the end).
- **Per-candidate virtual user behavior**: login → poll/receive exam assignment → `start()` session → open WS connection → send throttled webcam frames (per the agreed interval) + periodic integrity events → answer MCQ questions via autosave → write and submit code for coding questions → `submit()` session.
- **k6 script location**: `infra/loadtest/exam_session.js`, parameterized (candidate count, ramp duration, exam duration) via environment variables, not hardcoded — this script gets reused for every future capacity re-validation, not just this one-time proof.

### Scenario 2: Submission burst

- Models the realistic pattern of most candidates rushing to submit code near the exam deadline — validates `judge-worker`'s queue doesn't collapse under a sudden burst rather than the steady trickle Scenario 1 mostly exercises.
- **k6 script location**: `infra/loadtest/submission_burst.js`.

### Metrics captured per run (all must be real measured values in the results table at the bottom of this doc — no estimates)

- WS connect success rate (target: >99.9%)
- Frame ingestion latency p50/p95/p99 (gateway receive → Redis `XADD` ack)
- Redis Streams consumer lag over time for both `proctor:frames` and `proctor:events` (steady-state near-zero, bounded recovery time after the submission-burst scenario)
- `judge-worker` queue depth over time during Scenario 2, and time-to-drain
- API p95/p99 latency under load, per endpoint group (auth, exam CRUD, submission)
- Error rate across all services during the full run
- Resource usage per service (CPU/memory) at steady state and at peak, to validate HPA sizing

### What "pass" means

Explicitly define thresholds before running (put them in this doc, don't decide post-hoc what counts as good):
- WS connect failure rate < 0.1%
- Frame ingestion p95 < 2s
- Consumer lag returns to near-zero within a defined window after the submission burst (e.g. 2 minutes)
- API p95 < 500ms for CRUD endpoints under load
- Zero unhandled/5xx errors attributable to load rather than legitimate rejections (e.g. a `409 SESSION_EXPIRED` at the exact deadline boundary is expected, not a failure)

If a run misses a threshold, the DoD is not met — fix the bottleneck, re-run, don't lower the threshold to match the result.

---

## Kubernetes layout — full detail

```
infra/k8s/
  base/
    api/
      deployment.yaml       # resource requests/limits, readiness probe (/health/ready) distinct from liveness (/health/live)
      hpa.yaml               # CPU + memory based, standard
      pdb.yaml                # PodDisruptionBudget — minAvailable, protects against a rolling deploy taking too many replicas down at once
    proctor-gateway/
      deployment.yaml         # NOTE: readiness probe must reflect "accepting new connections", not just process-alive — a pod draining (Phase 3 shutdown logic) should flip readiness false while staying live for existing connections
      hpa.yaml                  # HPA on active-connection-count custom metric (via Prometheus Adapter), NOT plain CPU — CPU is a poor proxy for this service's actual bottleneck (connection count / memory per goroutine)
      pdb.yaml
    ml-service/
      deployment.yaml
      hpa.yaml                  # HPA on Redis consumer lag custom metric — scale out when lag grows, not just on CPU
      pdb.yaml
    judge-worker/
      deployment.yaml
      hpa.yaml                  # HPA on queue depth custom metric
      pdb.yaml
    web/
      deployment.yaml
      hpa.yaml
    data/
      postgres-statefulset.yaml (or a reference/secret pointing at a managed cloud DB — decide per the hosting-target open question)
      redis-statefulset.yaml (or managed Redis reference)
      minio-statefulset.yaml (or swap to real S3 in the production overlay)
    ingress.yaml                 # WS-aware routing to proctor-gateway (correct timeout/upgrade headers), TLS termination
  overlays/
    staging/
    production/
```

**Session affinity note**: `proctor-gateway` connections are long-lived per-pod (a candidate's WS stays on whichever pod accepted it), so the ingress does NOT need session affinity for routing new connections — each new connection can land anywhere, and the hub design (Phase 3) is per-pod, with cross-pod presence handled via the Redis-backed registry. Explicitly verify this assumption holds (no hidden single-pod dependency) as part of this phase's testing — it's a design decision from Phase 3 that this phase's load test is the first real proof of.

---

## Custom-metric HPA — implementation detail

- **Prometheus Adapter** (or KEDA, evaluate both, document the choice) exposes application-level metrics (active WS connections, Redis consumer lag, queue depth) as Kubernetes custom metrics the HPA controller can scale on.
- Each service must expose the relevant metric on `/metrics` in Prometheus format (see Observability section) before the HPA config referencing it can work — this is a hard dependency, sequence the work accordingly (metrics instrumentation before HPA wiring, not in parallel blind).

---

## Observability — full detail

### Metrics (Prometheus, `/metrics` on every service)

- **Standard RED per service**: request rate, error rate, duration histogram — for both HTTP endpoints and WS message handling.
- **`api`**: additionally, active session count by status, submission processing rate.
- **`proctor-gateway`**: additionally, active connection count (the HPA-driving metric), frames/events ingested per second, frames/events dropped per second (throttle drops — a rising drop rate under normal conditions could indicate the throttle is misconfigured, not just "working as intended"), reconnect count, `proctoringDegraded` session count.
- **`ml-service`**: additionally, consumer lag per stream (the HPA-driving metric for this service), detection latency per detector, flag rate per type, `storageFailed` count (should be near-zero in steady state — a rising trend means MinIO problems worth alerting on).
- **`judge-worker`**: additionally, queue depth (the HPA-driving metric), job processing latency, sandbox timeout/kill rate, container-start-failure rate.

### Dashboards (Grafana)

- One dashboard per service (the metrics above) + one system-wide overview (active exam sessions, total connected candidates, overall error rate, overall consumer lag) suitable for glancing at during a live exam window.

### Logs (Loki)

- All services' structured JSON logs shipped to Loki, queryable by `correlationId` and `sessionId` — given the correlation ID propagation established in Phase 1, this phase is mostly about the shipping pipeline, not inventing new fields.

### Traces (OpenTelemetry)

- Trace context propagated across the frame pipeline specifically: `apps/web` capture → `proctor-gateway` ingest → Redis Streams → `ml-service` consume → flag write. This is the path most likely to have hidden latency (a slow detector, a Redis hiccup, a MinIO retry) that aggregate metrics alone won't pinpoint — tracing is what lets you find *which* frame's journey was slow and why.

### Alert rules (at minimum, wired and tested before this phase is done)

- Redis consumer lag (either stream) exceeds a threshold for a sustained period → alert (feeds the "ML misflag storm" / degraded-proctoring runbook in Phase 6).
- `proctor-gateway` WS connect failure rate exceeds a threshold → alert (feeds the "gateway connection drop" runbook).
- `judge-worker` sandbox timeout/kill rate spikes abnormally → alert (could indicate either a bad question test case or a coordinated abuse attempt — feeds the "sandbox escape suspicion" runbook, even though a spike isn't proof of an actual escape, it's the trigger to investigate).
- Every alert rule must have a documented "what does this mean, what's the first action" — a fired alert with no corresponding runbook entry is an incomplete alert, not a done one.

---

## Security hardening pass — full detail

- Rate limiting confirmed under load (Phase 1 built it, this phase validates it survives real concurrent traffic without itself becoming a bottleneck).
- WS `Origin` validation confirmed against the production domain list, not left as a permissive dev default.
- Dependency vulnerability scanning: `npm audit` (api, web), `govulncheck` (proctor-gateway, judge-worker), `pip-audit` (ml-service) — wired into CI, high-severity findings block merge, and this phase includes an initial full clean pass (fix or explicitly waive-with-reason anything currently flagged) rather than just wiring the check going forward.
- Standard security headers on `apps/web`/`apps/api` responses (CSP, `X-Content-Type-Options`, `Strict-Transport-Security`, etc.) — reasonable defaults for a student-facing exam platform, tuned to not break the Monaco editor/webcam APIs the app actually needs.
- TLS everywhere in production (`wss://` for the gateway, `https://` for everything else) — no plaintext fallback.

---

## Deployment runbook — must include

1. Pre-deploy checklist (migrations reviewed, load test results still valid for current traffic expectations, on-call aware of the deploy window).
2. Deploy steps (image build/push, manifest apply, rollout status check per service).
3. Post-deploy verification (health checks green, a synthetic smoke test of the full exam flow against production).
4. Rollback steps (previous image tag, manifest revert, verification the rollback itself is healthy) — written out concretely, not "use kubectl rollout undo" as the entire plan; include what to check before declaring the rollback successful.
5. Mid-exam deploy policy: given Phase 3's graceful-shutdown design, deploys during an active exam window are technically survivable, but document whether Gridixa's process is to still avoid deploying during live exam windows as a matter of policy (belt-and-suspenders), and who has authority to override that in an emergency (e.g. a critical security patch).

---

## Edge cases — must be handled and tested this phase

- **Node failure mid-load-test**: verify PodDisruptionBudgets and HPA correctly reschedule without the whole system falling over — a single node loss should look like the graceful-shutdown/reconnect case from Phase 3 to affected candidates, not a hard failure.
- **HPA flapping** (scaling up and down rapidly under bursty load): verify stabilization windows are configured sensibly, not left at raw defaults that could thrash under this specific traffic pattern (frame ingestion is fairly steady, submission bursts are spiky — the HPA config should account for that difference between services).
- **Database migration during a rolling deploy**: verify the migration strategy is backward-compatible during the rollout window (old and new pod versions coexisting briefly must both work against the migrated schema) — document the migration policy (e.g. always additive/expand-then-contract across two deploys, never a breaking single-step migration).
- **Certificate rotation / expiry**: verify TLS cert renewal doesn't require a manual, error-prone process — automated renewal (e.g. cert-manager) preferred, tested at least once in staging.
- **Load test itself causing false alerts or polluting production dashboards**: run load tests against staging, and if a production-adjacent run is ever needed, document how to distinguish load-test traffic in dashboards/logs (a tag or label) so it doesn't get mistaken for real incident data later.

---

## Testing requirements

- k6 scripts for both scenarios, version-controlled, parameterized, run against a staging environment sized like production (not localhost — localhost numbers are not evidence of production capacity).
- Explicit threshold-based pass/fail built into the k6 script output (or the CI job wrapping it), not just eyeballed dashboards after the fact.
- Chaos-style test: kill a pod of each scalable service mid-load-test, verify recovery within an acceptable window.

---

## Definition of Done

- [ ] Load test executed against a production-like staging environment; all metrics in the results table below filled with real numbers, all defined thresholds met — if not met, bottleneck identified, fixed, and re-run until met
- [ ] Gateway confirmed to not require session affinity for scaling; verified under the load test with connections distributed across multiple pods
- [ ] HPA configs live for all four scalable services on their correct custom metrics (connection count, consumer lag, queue depth, or CPU where appropriate), verified to actually scale up and back down during the load test
- [ ] Dashboards live showing real load-test traffic; every alert rule fires correctly when its condition is synthetically triggered
- [ ] Security scan clean of high-severity findings (fixed or explicitly waived with documented reason)
- [ ] Node-failure and HPA-flapping edge cases tested
- [ ] Runbook reviewed and a full deploy + rollback rehearsed at least once in staging
- [ ] Production deployment completed for Gridixa
- [ ] `PROJECT_STATUS.md` updated, all Phase 1–5 rows marked done, resume bullet points drafted from these real measured outcomes (per `CLAUDE.md` §1.1 — no invented metrics)

## Load test results (fill in after real runs only)

| Metric | Threshold | Actual | Date |
|---|---|---|---|
| Concurrent WS connections sustained | 1000 | `[MEASURE]` | |
| WS connect failure rate | <0.1% | `[MEASURE]` | |
| Frame ingestion p95 latency | <2s | `[MEASURE]` | |
| Redis Streams consumer lag (steady state) | near-zero | `[MEASURE]` | |
| Consumer lag recovery time after submission burst | <2 min | `[MEASURE]` | |
| Judge-worker queue drain time (burst scenario) | `[define]` | `[MEASURE]` | |
| API p95 latency under load (CRUD) | <500ms | `[MEASURE]` | |
| API p95 latency under load (submission) | `[define]` | `[MEASURE]` | |
| Error rate (excluding expected business rejections) | ~0% | `[MEASURE]` | |
| Peak CPU/memory per service | within request/limit | `[MEASURE]` | |
