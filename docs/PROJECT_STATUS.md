# Project Status — AI Olympiad Proctored Exam Platform

**Last updated:** 2026-07-10
**Current phase:** Phase 2 complete — Phase 3 up next

## Phase overview

| Phase | Name | Status | Notes |
|---|---|---|---|
| 1 | Foundation & Infrastructure | Done | Monorepo, Docker Compose, DB schema, auth skeleton |
| 2 | Core Exam Engine | Done | Exam CRUD, sessions, autosave, manual submit, auto-grader & Go sandbox |
| 3 | Realtime Proctoring Gateway | Not started | Go WS gateway, event/frame ingestion, Redis Streams |
| 4 | ML Flagging Service | Not started | Face/gaze/object detection, flag pipeline, MinIO |
| 5 | Scale, Load Test & Deploy | Not started | k8s, load testing to 1000 concurrent, observability |
| 6 | Hardening, Compliance & Handover | Not started | DPDP/biometric-data compliance, DR, cost, docs handover to Gridixa |

## Key decisions log

| Date | Decision | Rationale |
|---|---|---|
| 2026-07-09 | Polyglot stack: NestJS + Go + Python/FastAPI + Next.js | See `docs/TECH_STACK.md` — workload profiles differ too much for one runtime |
| 2026-07-09 | Redis Streams over Kafka at launch | Sufficient at 1000 concurrent, lower ops overhead; Kafka is a documented Phase 5 upgrade path if load testing says otherwise |
| 2026-07-09 | No video recording — flagged frames only | Product/privacy decision, non-negotiable |
| 2026-07-09 | Server-side ML flagging (not client-side TF.js) | Centralizes detection logic, avoids trusting client, easier to iterate on models |
| 2026-07-09 | Proctoring signals: webcam (live, unrecorded) + tab-switch + copy-paste — no screen recording | Scope decision for v1 |
| 2026-07-10 | Argon2id password hashing | Chosen over bcrypt for better resistance to GPU-based brute-force cracking |
| 2026-07-10 | SHA-256 Refresh Token hashing | Storing hashed refresh tokens prevents session hijacking in the event of a database leak |
| 2026-07-10 | Deny-by-default RBAC | Every route blocks access unless explicitly decorated with a `@Roles()` permission or marked `@Public()` |
| 2026-07-10 | Ephemeral Docker Sandboxing | Restricting container execution boundaries (network none, 128m memory, 0.5 cpus, pids-limit 20, read-only root, 10m tmpfs) prevents sandbox escapes and fork bombs |
| 2026-07-10 | Postgres ROW Locks for Exam Session transitions | Using `SELECT FOR UPDATE` inside a database transaction guarantees strict state transitions and prevents double session starts |
| 2026-07-10 | Debounced autosave & payload filtering | Debouncing draft updates reduces database write overhead. Stripping MCQ correctOption & non-public testCases preserves exam integrity |

## Resolved questions

| Date | Question | Answer |
|---|---|---|
| 2026-07-10 | MCQ only or MCQ + coding? | **Both.** `judge-worker` is in scope for Phase 2, not deferred. |
| 2026-07-10 | Gridixa SSO or standalone auth? | **Standalone.** Own `User`/`RefreshToken` tables in `apps/api`, no external IdP dependency for v1. Auth module stays behind an interface so a future OIDC/SSO bridge doesn't require a rewrite. |
| 2026-07-10 | Webcam frame capture interval | **1 frame / 2 seconds.** Standard interval selected for balance between network load and detection accuracy. |
| 2026-07-10 | Auto-submit leftover sessions | **Confirmed.** Leftover exam sessions are automatically submitted when the duration limits expire. |

## Open questions (still need answers before the relevant phase)

- [ ] Data retention policy for flagged frames (proposed default: 90 days, auto-delete from MinIO) (needed before Phase 4, feeds Phase 6 compliance)
- [ ] Hosting target for production (cloud provider) — affects Phase 5 k8s manifests (needed before Phase 5)
- [ ] Confirm whether Gridixa has an existing legal review process for biometric/webcam data (near-certain DPDP Act 2023 applicability given India-focused student data) (needed before Phase 6)

## Next action

Start Phase 3 — see `docs/PHASE_3_REALTIME_PROCTORING.md` to design and implement the realtime gateway for websocket streaming.
