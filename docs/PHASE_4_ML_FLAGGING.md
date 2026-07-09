# Phase 4 — ML Flagging Service

**Goal:** Frames and events flowing into Redis Streams (Phase 3) are reliably consumed by the Python ML service, analyzed for face/gaze/object violations, and turned into reviewable flags with a single stored snapshot frame — with the consumer pipeline proven not to lose, duplicate, or silently choke on adversarial/corrupted input.

---

## Scope

- Redis Streams consumer group reading `proctor:frames` and `proctor:events`, horizontally scalable, at-least-once delivery handled correctly
- Face detection (0 or 2+ faces), gaze estimation (sustained away-gaze), secondary-device/phone detection
- Flag pipeline: detection → confidence scoring → persistence (MinIO frame + Postgres row) → live alert
- Proctor review UI (in `apps/web`, backed by `apps/api` querying this service's data)
- Retention job for expired flagged frames

---

## File/folder structure

```
apps/ml-service/
  app/
    main.py                     # FastAPI: /health, internal query endpoints for apps/api
    consumers/
      frame_consumer.py          # XREADGROUP loop over proctor:frames, ack + reclaim logic
      event_consumer.py           # XREADGROUP loop over proctor:events (tab-switch/copy-paste threshold flags)
    detectors/
      base.py                     # Detector ABC/protocol — strategy pattern per CLAUDE.md §1.4
      face_detector.py             # MediaPipe Face Mesh: count + landmarks
      gaze_detector.py              # derived from landmarks + a per-session sliding window in Redis
      object_detector.py             # ONNX Runtime, phone/device classes
    pipeline/
      flag_pipeline.py              # runs detectors, aggregates, decides flag-worthy, persists, dedupes
    storage/
      minio_client.py                # upload with retry/backoff, graceful degradation on failure
    models/
      onnx/                          # model weights, gitignored, fetched via a setup script — never committed to git
    core/
      config.py, logging.py, correlation.py   # same conventions as Phase 1
  requirements.txt
  Dockerfile
```

---

## Consumer group design — full detail

- Redis Streams consumer group per stream (`cg:frames`, `cg:events`), one logical group shared across all `ml-service` replicas — each replica is a distinct **consumer** within the group (`consumer-<pod-id>`), enabling horizontal scaling without duplicate processing of the same entry.
- Read loop: `XREADGROUP GROUP cg:frames consumer-<id> COUNT <batch> BLOCK <ms> STREAMS proctor:frames >` — blocking read, not a tight poll loop.
- **Ack only after successful, fully-persisted processing**: `XACK` is the last step of `flag_pipeline.py`, after the Postgres write (and MinIO write, or its documented fallback) succeeds — if the process crashes mid-processing, the entry remains in the Pending Entries List (PEL) and gets redelivered, not lost.
- **Idempotent processing is mandatory, not optional**, because of at-least-once delivery: every `ProctorFlag` write is keyed so a redelivered `frameId` doesn't create a duplicate flag — either an upsert keyed on `frameId`, or a pre-check (`SELECT ... WHERE frameId = ...`) inside the same transaction as the insert.
- **Crashed-consumer recovery**: a periodic reclaim job uses `XAUTOCLAIM` (or `XPENDING` + `XCLAIM` on older Redis) to pick up entries that have been pending longer than a threshold (e.g. 60s) under a dead consumer's name, reassigning them to a live consumer — without this, a crashed pod silently loses whatever it had in flight.
- **Poison-pill protection**: if a specific entry fails processing repeatedly (e.g. corrupted frame data that always throws), track a retry count (e.g. in the entry's redelivery count via `XPENDING`, or an explicit side counter) and after N failures, ack it anyway and log it to a dead-letter concept (a Postgres `ProcessingFailure` row or equivalent) rather than looping on it forever and starving the rest of the stream.

---

## Detector interface — full detail

```python
class Detector(Protocol):
    name: str
    def detect(self, frame: DecodedFrame, session_context: SessionContext) -> list[DetectionResult]:
        ...

@dataclass
class DetectionResult:
    flag_type: str          # matches ProctorFlag.type enum
    confidence: float        # 0.0-1.0
    metadata: dict            # detector-specific extra info (e.g. face count, bounding boxes)
```

Each concrete detector (`FaceDetector`, `GazeDetector`, `ObjectDetector`) implements this independently. `flag_pipeline.py` iterates over a configured list of active detectors — adding a new detector (e.g. audio-based cheating detection later) means adding a new class and registering it, never touching the pipeline's control flow (strategy pattern per `CLAUDE.md` §1.4).

**Face detector**: MediaPipe Face Mesh, returns face count + rough head-pose landmarks per detected face. `flag_type = NO_FACE` if count == 0, `MULTI_FACE` if count >= 2.

**Gaze detector**: derives a coarse gaze direction from head-pose/eye landmarks (not a precise eye-tracker — good enough for "clearly looking away," not pixel-level gaze). Maintains a small per-session sliding window in Redis (`gaze:session:<id>`, TTL matching exam duration) — only flags after N consecutive away-gaze detections over a minimum duration (e.g. 5+ seconds sustained), explicitly to suppress false positives from normal short glances. This threshold is a config value, not hardcoded, and should be tunable without a redeploy if a config-reload mechanism is in place (or at minimum, isolated in `config.py` for a quick redeploy-tune cycle).

**Object detector**: ONNX Runtime inference on the frame (or a cropped region), looking for phone/secondary-device classes from a lightweight pretrained/fine-tuned model. Confidence threshold deliberately biased toward fewer false positives — flag_type = `DEVICE_DETECTED`. Document the chosen threshold and the tradeoff explicitly (a wrongly flagged honest candidate is a worse product outcome than an occasional missed violation, given this is a real product with real students).

---

## Flag pipeline — full detail

1. Decode frame bytes (or fetch from MinIO reference if Phase 3 chose that path) — **wrapped in a try/except that never lets a corrupted/undecodable frame crash the consumer loop**; a decode failure is logged, the entry is acked (it's unrecoverable, redelivering it won't help), and processing moves to the next entry.
2. Run each active detector; catch and isolate exceptions **per detector**, not just per frame — if `ObjectDetector` throws (e.g. a model-loading edge case), `FaceDetector` and `GazeDetector` results should still be processed and potentially flagged; one detector's bug shouldn't blind the other two.
3. Aggregate `DetectionResult`s; any result crossing its type's confidence threshold is flag-worthy.
4. For each flag-worthy result: idempotency check (§ above) → upload the single triggering frame to MinIO (retry with backoff on transient failure; on persistent failure, write the `ProctorFlag` row anyway with `frameUrl: null` and `storageFailed: true` per `CLAUDE.md` §2.4 — a flag without an image is still actionable, a silently dropped flag is not) → write `ProctorFlag` row → publish a live alert via Redis Pub/Sub (`proctor:alerts:<sessionId>` or a shared channel filtered by the gateway) → `XACK` the stream entry.
5. Non-flag-worthy results are simply not persisted (no need to store "checked, all clear" for every single frame at this volume — only flag-relevant outcomes are durable data).

**Event consumer** (tab-switch/copy-paste from `proctor:events`): simpler pipeline — increment a per-session counter in Redis, and if a configured threshold is crossed (e.g. 3+ tab switches), write a `ProctorFlag` of type `TAB_SWITCH`/`COPY_PASTE` the same way (idempotent — don't re-flag every single event past the threshold, only the threshold-crossing transition).

---

## Data model additions

```prisma
enum FlagType {
  NO_FACE
  MULTI_FACE
  GAZE_AWAY
  DEVICE_DETECTED
  TAB_SWITCH
  COPY_PASTE
  CONNECTION_LOST
}

enum ReviewStatus {
  PENDING
  CONFIRMED
  DISMISSED
}

model ProctorFlag {
  id            String       @id @default(uuid())
  sessionId     String
  type          FlagType
  confidence    Float?
  frameUrl      String?               // null if storage failed — see storageFailed
  storageFailed Boolean      @default(false)
  metadata      Json?                  // detector-specific detail, e.g. face count, bounding box
  correlationId String?
  createdAt     DateTime     @default(now())
  reviewedBy    String?
  reviewedAt    DateTime?
  reviewStatus  ReviewStatus @default(PENDING)

  @@unique([sessionId, type, createdAt])   // coarse dedupe guard alongside application-level idempotency
  @@index([sessionId])
  @@index([reviewStatus])
}
```

---

## MinIO storage details

- Bucket layout: `proctor-flags/<examId>/<sessionId>/<flagId>.jpg` — predictable, makes the Phase 6 deletion job straightforward (delete by prefix for a session).
- Upload via presigned PUT or direct SDK call with retry (exponential backoff, capped attempts) before falling back to the `storageFailed: true` path.
- Access to flagged frames from the admin dashboard via short-lived presigned GET URLs, never a permanently public bucket/object — this is sensitive biometric data (ties into Phase 6 compliance).

---

## Edge cases — must be handled and tested this phase

- **Corrupted/undecodable frame data**: handled per pipeline step 1 — acked and logged, never crashes the loop; explicit test with intentionally malformed bytes.
- **One detector throwing while others succeed**: per pipeline step 2 — explicit test that a forced exception in one detector doesn't suppress results from the others.
- **Duplicate delivery of the same frame** (at-least-once semantics): explicit test — deliver the same stream entry twice, assert only one `ProctorFlag` results.
- **Consumer crash mid-processing**: explicit test using `XPENDING`/manual crash simulation — verify the entry is reclaimable and eventually processed exactly-once-effectively (at-least-once delivery, idempotent effect).
- **MinIO unavailable**: explicit test — flag still gets written with `storageFailed: true`, `frameUrl: null`, not silently dropped.
- **Gaze false positives from a brief normal glance**: explicit test that a single short away-gaze reading below the sustained-duration threshold does NOT produce a flag.
- **Poison-pill entry that always fails**: explicit test — after N retries, entry is acked and logged as a `ProcessingFailure`, doesn't block the stream indefinitely.
- **High consumer lag under load**: not a "handled" edge case so much as an observable one — verify a lag metric exists and is queryable (full alerting wiring is Phase 5, but the metric must exist now).
- **Retention/deletion job racing a pending review**: per `CLAUDE.md` §3.4 — decide and implement which wins (recommended: retention job skips any flag with `reviewStatus: PENDING` and a recent enough `createdAt` that it's still within the active review window; only sweeps flags that are past both the retention period AND already reviewed, or past a hard outer limit regardless of review status — document the exact rule chosen).

---

## Testing requirements

- pytest unit tests per detector against staged fixture frames (known-good faces, known no-face, known multi-face, staged device-in-frame) — not just synthetic noise, since detector correctness against realistic input is the actual point.
- Consumer group tests covering duplicate-delivery idempotency and crash/reclaim behavior — these can run against a real local Redis (via `docker compose`) rather than mocked, since the Streams semantics are the thing under test.
- Pipeline-level tests for the per-detector exception isolation and the MinIO-failure fallback path.
- Explicit false-positive-suppression test for the gaze detector's debounce window.

---

## Definition of Done

- [ ] Consumer group reliably drains `proctor:frames`/`proctor:events` under sustained local load without unbounded lag growth; lag is measurable
- [ ] No-face and multi-face detection verified against staged real test frames, not just unit-test fixtures
- [ ] Gaze-away flag has a tested debounce window and does not fire on short glances
- [ ] Device detection has a documented (measured, not assumed) false-positive rate on a small curated test set — `[MEASURE: ...]` filled with real numbers
- [ ] Duplicate-delivery idempotency proven by test
- [ ] Consumer crash/reclaim proven by test
- [ ] MinIO-unavailable fallback (`storageFailed: true`) proven by test
- [ ] Poison-pill handling proven by test (repeated-failure entry doesn't block the stream)
- [ ] Retention-vs-pending-review race rule implemented and documented per the decision above
- [ ] Flagged frame + Postgres row + live dashboard alert consistent end-to-end for a manually triggered test flag
- [ ] `PROJECT_STATUS.md` updated
