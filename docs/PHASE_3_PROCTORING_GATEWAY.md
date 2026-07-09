# Phase 3 — Realtime Proctoring Gateway

**Goal:** Every active exam session holds a WebSocket connection to the Go gateway for the full exam duration, streaming throttled webcam frames and client-side integrity events, with the gateway proven to hold 1000 concurrent connections under test and to degrade safely (never crash) when any downstream (Redis, API) misbehaves.

---

## Scope

- Go WebSocket gateway: connection lifecycle tied 1:1 to an `ExamSession`
- Client-side capture in `apps/web`: webcam frame extraction, tab-visibility/blur/copy/paste/fullscreen-exit events
- Frame + event ingestion → Redis Streams, with server-side throttling independent of the client
- Backpressure handling: bounded buffers, explicit drop policy, never unbounded memory growth per connection
- Presence registry queryable by the admin dashboard
- Reconnect handling with a defined grace period
- Graceful shutdown that doesn't fail every active exam on a deploy

---

## File/folder structure

```
apps/proctor-gateway/
  cmd/gateway/
    main.go
  internal/
    ws/
      hub.go                # sessionID -> *Connection registry, add/remove, broadcast to admin stream
      connection.go          # per-connection struct: readPump(), writePump(), send channel (buffered, bounded)
      upgrade.go             # HTTP->WS upgrade handler, origin check, single-purpose token verification
    protocol/
      messages.go            # binary frame header format + JSON event schema, encode/decode
      throttle.go             # server-side per-session rate limiter (token bucket)
    ingest/
      frame_handler.go        # validate -> throttle -> publish to Redis Stream proctor:frames
      event_handler.go         # validate -> threshold check -> publish to proctor:events, immediate flag on threshold breach
    authz/
      token_verify.go          # verifies short-lived WS session token issued by apps/api
    registry/
      presence.go               # in-memory + Redis-backed presence, internal REST endpoint for admin queries
    middleware/
      correlation.go
      recover.go                # panic recovery per-connection goroutine — a panic in one connection's pump must not kill the process
    shutdown/
      drain.go                  # SIGTERM handling: stop accepting new connections, drain existing ones with a timeout
  go.mod
  Dockerfile
```

---

## WebSocket protocol — full detail

**Connection URL:** `wss://.../v1/proctor/connect?token=<ws_session_token>`

**Upgrade-time validation (before accepting the WS handshake):**
1. `Origin` header checked against an allowlist — reject otherwise (§6 security).
2. `ws_session_token` verified: short-lived (bound to exam duration + small buffer), single-purpose (only valid for WS auth, distinct signing context from the general access token per `CLAUDE.md` §4.2), issued by `apps/api` at session `start()`.
3. Token's `sessionId` looked up in the hub — if a connection for that `sessionId` already exists, **reject the second connection** (`4001` close code, custom reason `SESSION_ALREADY_CONNECTED`) rather than allowing two simultaneous streams for one candidate (closes the duplicate-tab edge case at the gateway layer, complementing the `ExamSession` DB uniqueness from Phase 2).

**Message framing** (binary WS frames, first byte = message type, avoids parsing JSON for every high-frequency frame message):
```
byte 0:      message type (0x01 = webcam frame, 0x02 = integrity event)
bytes 1-8:   client timestamp (uint64, ms since epoch) — advisory only, never trusted for ordering/authority
bytes 9-N:   payload
             - type 0x01: JPEG bytes (webcam frame)
             - type 0x02: JSON payload (integrity event, see schema below)
```

**Integrity event JSON schema:**
```json
{ "eventType": "TAB_BLUR|TAB_FOCUS|VISIBILITY_HIDDEN|VISIBILITY_VISIBLE|COPY|PASTE|FULLSCREEN_EXIT|FULLSCREEN_ENTER|DEVTOOLS_SUSPECTED", "clientTimestamp": 1234567890 }
```

**Server → client messages** (JSON, low frequency): connection ack, grace-period warning on detected drop-and-reconnect, forced disconnect notice with reason.

---

## Connection lifecycle & hub design

- `hub.go` holds `map[sessionID]*Connection`, guarded by a `sync.RWMutex` (or sharded map if lock contention shows up under the Phase 5 load test — don't pre-optimize before measuring).
- Each `Connection` runs two goroutines: `readPump()` (reads inbound frames/events, applies throttle, publishes) and `writePump()` (drains a buffered `chan []byte` for outbound server messages) — standard Gorilla pattern, chosen specifically because it isolates read/write blocking from each other.
- `writePump`'s send channel is **bounded** (e.g. 16 messages) — if a slow/stuck client can't keep up with even the low-frequency server→client messages, the connection is closed rather than the channel growing unbounded (memory safety at 1000 connections).
- Every connection's goroutines wrapped in panic-recovery middleware — one malformed frame triggering a decode panic must not take down the process for the other 999 sessions.
- Ping/pong keepalive tuned for exam-length connections (e.g. ping every 30s, pong timeout 60s) — distinguishes a genuinely dead connection from one that's just quiet between throttled frame sends.

---

## Server-side throttling (never trust client throttling alone)

- Token-bucket rate limiter per session in `protocol/throttle.go`: default capacity tuned to the agreed frame interval (see `PROJECT_STATUS.md` open question — proposed 1 frame/2s, i.e. bucket refills at 0.5/sec) plus a small burst allowance.
- Frames arriving faster than the bucket allows are **dropped silently at the gateway** (not queued, not erroring the connection) — the client isn't told, since a tampered/buggy client sending frames too fast is expected adversarial behavior, not something to negotiate with.
- Integrity events are similarly capped per time window (e.g. max 20 events/10s) to prevent a scripted flood from overwhelming Redis/Postgres — excess events beyond the cap in a window are dropped and a single `EVENT_RATE_EXCEEDED` marker is recorded instead, so the flood itself becomes visible to a reviewer without processing every individual spammed event.

---

## Redis Streams schema

**`proctor:frames`** — fields: `sessionId`, `frameId` (server-generated UUID, used for downstream idempotency), `serverTimestamp` (authoritative), `clientTimestamp` (advisory), `correlationId`, `data` (JPEG bytes or a MinIO pre-signed upload reference if frame size testing shows raw bytes-in-stream is too heavy — decide during implementation, document the choice).

**`proctor:events`** — fields: `sessionId`, `eventId`, `eventType`, `serverTimestamp`, `clientTimestamp`, `correlationId`.

Both streams: gateway publishes with `XADD`, approximate trimming (`MAXLEN ~`) to bound stream size, since this is telemetry, not a durable ledger — losing very old unprocessed entries under extreme backlog is an accepted degradation, not a bug (document this explicitly, matching the "frames are best-effort" decision in `CLAUDE.md` §2.4/Phase 6 DR notes).

---

## Backpressure & Redis-unavailable handling

- If `XADD` to Redis fails or times out: gateway does **not** block the connection's read pump waiting for Redis to recover. It buffers a small bounded number of pending publishes in memory per connection (e.g. last 5), and beyond that cap, starts dropping new frames — marking the session's presence record as `proctoringDegraded: true` so the admin dashboard can surface "telemetry gap" rather than silently pretending everything is fine.
- Once Redis recovers, buffered (non-dropped) items flush; the connection itself is never torn down just because Redis was briefly unavailable — losing some telemetry is acceptable, failing a candidate's exam because of an infra blip is not.

---

## Reconnect & grace period

- On unexpected close (network drop, not an explicit logout/forced-disconnect), the hub does **not** immediately remove the session from the presence registry — it marks it `disconnectedAt: now()` and starts a grace window (e.g. 30s, tune based on testing).
- If the client reconnects with a valid token for the same `sessionId` within the window, the connection resumes as normal — no flag raised for the brief gap, only an `AuditLog`/telemetry note of the gap duration.
- If the grace window expires without reconnection, the session is flagged `CONNECTION_LOST` (a `ProctorFlag` type, written via the same event path) and removed from active presence — this is a genuine signal worth a reviewer's attention, distinct from a normal blip.
- Exam session state (Phase 2) is **not** auto-failed by a connection loss — proctoring and exam-taking are decoupled; a candidate can keep answering questions via `apps/api` even if the proctoring WS is reconnecting, and the flag is what a human reviewer acts on, not an automatic exam termination (avoids an infra blip costing a candidate their exam outright).

---

## Graceful shutdown (rolling deploys)

- On `SIGTERM`: stop accepting new WS upgrades immediately (return `503` so a client's reconnect logic backs off and retries against a fresh pod), but do **not** forcibly close existing connections — let them either finish naturally or hit the load balancer's connection-drain timeout.
- This makes a mid-exam deploy look like the reconnect/grace-period case above from the candidate's perspective (brief blip, auto-resume against a new pod), not a hard failure — directly closes the "service restart mid-exam" edge case from `CLAUDE.md` §3.5.

---

## Presence registry

- In-memory per-pod map plus a Redis-backed shared view (`SET`/hash keyed by `sessionId` → pod identity + connected/degraded/disconnected state) so the admin dashboard (served via `apps/api`, which queries this) sees an accurate cross-pod live count, not just one pod's local view.
- Internal endpoint (`GET /internal/presence` or similar, not public) for `apps/api` to query current status per session or aggregate counts.

---

## Edge cases — must be handled and tested this phase

- **Connection storm**: many candidates connecting within the same short window (exam start) — verify the upgrade path doesn't serialize on a single lock in a way that creates a connect-time pileup; measure explicitly in the Phase 5 load test, but structure the hub to avoid an obvious single point of contention now (e.g. sharded locking if a naive single mutex shows contention in a quick local benchmark).
- **Duplicate connection attempt for an already-connected session**: rejected per the upgrade-time check above — test explicitly.
- **Oversized or malformed frame payload**: validated (size cap, decodable-JPEG sanity check can be deferred to `ml-service`, but a basic size/type sanity check happens at the gateway) — reject without crashing the connection.
- **Redis unavailable for an extended period**: verify the bounded-buffer-then-drop behavior, and that `proctoringDegraded` is correctly surfaced rather than the connection dying.
- **Client sends frames/events faster than the throttle allows**: verify silent server-side drop, no error surfaced to a well-behaved client, no resource growth from a misbehaving one.
- **WS ping/pong timeout** (genuinely dead connection, no clean close): verify it's detected and cleaned from the hub within the keepalive timeout window, not left as a phantom entry.
- **Reconnect just inside vs just outside the grace window**: explicit boundary test for both outcomes (resume silently vs `CONNECTION_LOST` flag).
- **SIGTERM with active connections**: verify new upgrades are rejected while existing ones are allowed to drain, and no connection is forcibly killed mid-message.
- **Malicious `Origin` header / connection from an unexpected origin**: rejected at upgrade time, tested explicitly.

---

## Testing requirements

- `go test ./... -race` across the module, given the goroutine-per-connection design — race detection here is not optional.
- Goroutine leak check (`goleak` or equivalent) on hub add/remove cycles — a connection that disconnects must not leave its read/write pump goroutines running.
- Load test (first pass here, full validation in Phase 5): a Go-based or k6 WS load client opening N simulated concurrent connections (start at 100, work up toward 1000) sending throttled frames/events for a sustained period, watching memory/goroutine count for linear-not-exponential growth.
- Explicit tests for every edge case listed above.

---

## Definition of Done

- [ ] A candidate starting an exam automatically opens a WS connection; frames and events visibly flow into Redis Streams (verify via `redis-cli XRANGE`)
- [ ] Second connection attempt for an already-connected session is rejected; verified by test
- [ ] Server-side throttling verified independent of client behavior — a client sending frames at 10x the allowed rate does not result in 10x entries in `proctor:frames`
- [ ] Tab-switch/copy-paste events flow through with rate-capping verified under a simulated flood
- [ ] Redis-unavailable scenario tested: connection survives, `proctoringDegraded` surfaces correctly, buffered items flush on recovery
- [ ] Reconnect-within-grace-period resumes silently; reconnect-beyond-grace-period produces a `CONNECTION_LOST` flag — both verified by test
- [ ] Graceful shutdown verified: existing connections drain, new upgrades rejected, no forced mid-message disconnects
- [ ] `go test -race` and goroutine-leak checks clean
- [ ] Initial load test (100+ concurrent, working toward 1000) run with memory/goroutine numbers recorded in `PROJECT_STATUS.md` as `[MEASURE: ...]` filled in with real results, not estimates — full 1000-scale sign-off remains Phase 5's job
- [ ] Admin dashboard (even a minimal stub) shows live connected-candidate count from the presence registry
- [ ] `PROJECT_STATUS.md` updated
