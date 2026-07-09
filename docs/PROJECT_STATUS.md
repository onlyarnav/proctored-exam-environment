# Project Status — AI Olympiad Proctored Exam Platform

**Last updated:** 2026-07-09
**Current phase:** Not started — Phase 1 up next

## Phase overview

| Phase | Name | Status | Notes |
|---|---|---|---|
| 1 | Foundation & Infrastructure | Not started | Monorepo, Docker Compose, DB schema, auth skeleton |
| 2 | Core Exam Engine | Not started | Exam CRUD, questions, sessions, judge worker |
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

## Resolved questions

| Date | Question | Answer |
|---|---|---|
| 2026-07-10 | MCQ only or MCQ + coding? | **Both.** `judge-worker` is in scope for Phase 2, not deferred. |
| 2026-07-10 | Gridixa SSO or standalone auth? | **Standalone.** Own `User`/`RefreshToken` tables in `apps/api`, no external IdP dependency for v1. Auth module stays behind an interface so a future OIDC/SSO bridge doesn't require a rewrite. |

## Open questions (still need answers before the relevant phase)

- [ ] Expected exam duration and number of concurrent exam *events* (1000 users in one sitting vs 1000 spread across sessions) — affects Redis Streams sizing (needed before Phase 3)
- [ ] Frame capture interval for webcam checks (proposed default: 1 frame / 2s) — confirm false-positive/negative tradeoff (needed before Phase 3)
- [ ] Data retention policy for flagged frames (proposed default: 90 days, auto-delete from MinIO) (needed before Phase 4, feeds Phase 6 compliance)
- [ ] Hosting target for production (cloud provider) — affects Phase 5 k8s manifests (needed before Phase 5)
- [ ] Confirm whether Gridixa has an existing legal review process for biometric/webcam data (near-certain DPDP Act 2023 applicability given India-focused student data) (needed before Phase 6)

## Next action

Start Phase 1 — see `docs/PHASE_1_FOUNDATION.md`. Both blocking questions resolved; schema design proceeds with MCQ + coding question types and standalone auth from day one.
