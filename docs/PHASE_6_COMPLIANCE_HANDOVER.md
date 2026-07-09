# Phase 6 — Hardening, Compliance & Handover

**Why this phase exists:** Phases 1–5 make the platform work and scale. This phase makes it lawful and safe to run against real students' biometric data (webcam frames, face landmarks) as a production Gridixa product, and makes it maintainable by someone other than the person who built it.

---

## Scope

- India DPDP Act 2023 compliance review and implementation (webcam/face data is sensitive personal data; also consider whether candidates may be minors)
- Consent flow: explicit, informed, granular, withdrawable
- Data subject rights: access, correction, deletion
- Disaster recovery: backup/restore tested for real, not just configured
- Cost review against real Phase 5 load numbers
- Incident response runbooks, written out concretely, for the alert conditions wired in Phase 5
- Documentation handover to the Gridixa team

---

## DPDP Act 2023 — what this means concretely for this system

*(This is engineering-level compliance implementation guidance, not legal advice — a genuine legal review by Gridixa's counsel is still required before launch; this section defines what the system needs to be capable of so that review isn't blocked on missing technical capability.)*

- **Purpose limitation**: webcam frames/face data are processed only for exam-integrity flagging — this is already true by design (no other use case touches this data), but should be explicitly stated in the consent copy and privacy policy, not just implicit in the code.
- **Data minimization**: already reflected in the architecture (flagged frames only, no continuous recording) — this phase should audit that no code path anywhere accidentally persists more than the design calls for (e.g., verify `ml-service` never writes non-flagged frames anywhere, including debug/log paths).
- **Consent**: must be specific (not bundled into a generic "I agree to terms"), informed (states what's captured, why, retention period, who can access it), and — per DPDP — withdrawable, though withdrawal during an active exam has a practical consequence (see Edge Cases) that must be surfaced to the candidate at consent time, not discovered mid-exam.
- **Data Principal rights**: right to access what's held about them, right to correction, right to erasure (subject to legitimate retention needs like an active academic-integrity investigation) — implemented as the deletion request path below plus an access-request path (candidate/admin can retrieve what `ProctorFlag` records exist for a session).
- **Breach notification**: the incident runbooks below should include a data-breach-specific escalation path (who to notify, within what timeframe) even though this phase doesn't need to fully build out legal breach-notification tooling — at minimum, the technical steps to determine breach scope must be executable (query "what data existed for which sessions" quickly).
- **Storage limitation**: the retention policy (default 90 days, per `PROJECT_STATUS.md`) must be enforced automatically, not by manual process — already scoped in Phase 4's retention job, this phase adds the deletion-on-request path on top.
- **Children's data**: if any candidates are minors, DPDP has additional requirements (verifiable parental consent) — confirm with Gridixa whether the olympiad's candidate age range includes minors; if yes, this needs explicit additional design work before launch, flagged as a blocking legal question, not something to guess at technically.

---

## Consent flow — full detail

**Data model:**
```prisma
model ConsentRecord {
  id            String   @id @default(uuid())
  userId        String
  examSessionId String
  policyVersion String              // ties to a versioned copy of the privacy policy text, so old consents remain interpretable if policy changes later
  consentedAt   DateTime @default(now())
  withdrawnAt   DateTime?
  ipAddress     String?              // for audit/dispute purposes
  correlationId String?
}
```

- Consent screen presented and must be explicitly accepted before `ExamSession.start()` is permitted to proceed to `IN_PROGRESS` — enforced server-side (a client-side-only gate is not sufficient; `apps/api`'s `start()` endpoint checks for a valid `ConsentRecord` for that session).
- Consent copy (versioned, stored alongside the code or in a simple CMS-like table — decide based on how often Gridixa's legal team expects to revise it) must plainly state: what's captured (webcam frames only when flagged, tab-switch/copy-paste events, no continuous recording), why (exam integrity), retention period, who can access flagged data (proctors/admins, not shared externally), and how to request deletion/withdrawal.
- Withdrawal: a candidate can withdraw consent, but the practical consequence (likely: cannot continue a proctored exam without consent, so withdrawal during an active exam effectively means abandoning it) must be stated clearly at consent time, not sprung on them mid-exam.

---

## Deletion request path — full detail

**Job design:**
1. Request received (admin-triggered in v1; candidate-self-service is a documented future enhancement if not built now — decide and note the choice in `PROJECT_STATUS.md`).
2. Request checked against the hold window (default 30 days post-results, configurable) — a request during an active academic-integrity investigation on that session is queued/held with a clear status, not silently executed (deleting evidence mid-investigation would be a real problem).
3. On approval/hold-expiry: delete `ProctorFlag` rows for the session, delete corresponding MinIO objects (by the predictable `proctor-flags/<examId>/<sessionId>/` prefix from Phase 4), and log the deletion itself to `AuditLog` (the fact that data was deleted, and when, is itself a record worth keeping, even though the data isn't).
4. **Cross-service completeness**: deletion must cover Postgres (`ProctorFlag`), MinIO (frame objects), and any Redis-held ephemeral data tied to the session (gaze sliding-window keys, presence records) that might outlive the exam — audit for anything that could be "forgotten" storage before declaring this done (this is the single most common way a deletion feature quietly fails to actually delete everything).
5. Deletion request and completion status queryable by an admin (and ideally the candidate) so "did my deletion actually happen" isn't a black box.

---

## Disaster recovery — full detail

- **Backup schedule**: automated Postgres backups (frequency decided based on acceptable data loss window — e.g. hourly incremental + daily full, tune to the actual RPO target once defined).
- **RTO/RPO definition**: define these explicitly for this system before testing against them — e.g. "RPO: max 1 hour of exam data loss acceptable in a disaster; RTO: system restorable within 4 hours" — these are business decisions to confirm with Gridixa, not purely technical ones, and the DR test below should validate against whatever numbers are actually agreed, not arbitrary ones.
- **Restore test**: actually restore a backup into a scratch environment (not staging, to avoid any risk to real data) and verify data integrity (row counts, referential integrity, spot-check known records) — do this for real, document the actual time taken and any gaps found, don't mark this done because backups are merely configured and never actually restored.
- **Redis/MinIO data loss tolerance**: explicitly documented as accepted (Redis Streams telemetry is best-effort per `CLAUDE.md` §2.4; MinIO flagged frames are more important — confirm MinIO's own backup/replication story, e.g. if self-hosted, is it backed up at all, or only relying on the underlying disk's redundancy — this is often the actual gap in a "we have DR" claim).

---

## Cost review

- Pull real resource usage numbers from the Phase 5 load test (CPU/memory per service at steady state and peak) and right-size Kubernetes resource requests/limits accordingly — don't carry forward guessed values from before the load test existed.
- Review managed-service costs (if using cloud-managed Postgres/Redis/S3 instead of self-hosted per the Phase 5 hosting-target decision) against actual measured throughput needs, not headroom padded on assumption.
- Document the cost review outcome and any changes made, so it's traceable why the production sizing is what it is.

---

## Incident runbooks — written out concretely

### Runbook 1: ML flagging misflag storm / abnormal flag rate spike
1. **Trigger**: alert from Phase 5 (flag rate per type spikes abnormally, or consumer lag alert fires alongside it).
2. **First action**: check the `ml-service` Grafana dashboard — is this a genuine spike in candidate behavior (unlikely at scale, worth ruling out first) or a detector regression (e.g. a bad model reload, a config change, a lighting/environment shift across many candidates simultaneously — e.g. a shared exam center with bad lighting)?
3. **Mitigation**: if a detector regression is suspected, the affected detector can be disabled independently (per the strategy-pattern design, this is a config toggle, not a code change) while investigation continues — the other detectors keep running.
4. **Follow-up**: any flags raised during the suspected-bad window should be marked for priority manual review, not treated as reliable signal until the cause is confirmed.

### Runbook 2: Gateway connection drop spike
1. **Trigger**: alert from Phase 5 (WS connect failure rate or unexpected-disconnect rate exceeds threshold).
2. **First action**: check whether this correlates with a deploy (should look like the graceful-shutdown case, self-resolving) or an infra issue (node failure, network partition, Redis unavailability triggering the degraded-mode path across many sessions at once).
3. **Mitigation**: if infra-driven, follow standard node/network recovery for the affected component; the grace-period design (Phase 3) buys time before candidates are actually flagged as `CONNECTION_LOST`, so there's a window to fix the underlying issue before it affects exam outcomes — communicate this window to whoever's monitoring live exams so they don't panic-escalate a self-healing blip.
4. **Follow-up**: review how many sessions crossed into `CONNECTION_LOST` during the incident and whether any need manual review/accommodation (e.g. extended time) as a fairness matter, separate from the technical fix.

### Runbook 3: Sandbox escape suspicion
1. **Trigger**: alert from Phase 5 (abnormal sandbox timeout/kill rate spike) — note this is a *suspicion* trigger, not proof of an actual escape.
2. **First action**: identify the specific submission(s)/candidate(s) correlated with the spike; check `judge-worker` logs for the specific containers involved.
3. **Mitigation (if escape genuinely suspected, not just a bad test case)**: this is the most severe runbook — immediately pause `judge-worker` job processing (stop pulling new jobs), isolate/inspect the affected host(s), do not simply restart and continue processing until the mechanism is understood, given this touches host-level container isolation.
4. **Follow-up**: this is a security-incident-severity event even if it turns out to be a false alarm from a legitimately resource-heavy but non-malicious submission — document the finding either way, and if it was a genuine near-miss, treat hardening the specific gap as a blocking follow-up before resuming full judge-worker capacity.

---

## Documentation handover

- **Architecture diagram**: system-wide view (all 5 services + data stores + external boundaries) — a Mermaid diagram checked into `docs/` is sufficient, doesn't need to be a separate tool.
- **Extension guides**: "how to add a new question type," "how to add a new proctoring detector" — concrete, step-by-step, referencing the actual interfaces (`LanguageRunner`, `Detector`) established in Phases 2 and 4, so the Gridixa team can extend the system without re-deriving the patterns from scratch.
- **Ownership boundaries**: explicit statement of what Arnav owns going forward vs what the Gridixa team owns, and the backlog of deliberately-deferred ideas (Kafka migration path, video-based re-review, client-side detector experiments, candidate-self-service deletion if not built in v1) each with a one-line "why not now" — so a future maintainer doesn't mistake a deliberate scope decision for an oversight.

---

## Edge cases — must be handled and tested this phase

- **Deletion request during an active review hold**: verify it's correctly queued/blocked, not silently executed or silently dropped — the requester should get a clear status, not silence.
- **Deletion request that only partially completes** (e.g. Postgres row deleted but MinIO object deletion fails): the job must be retryable/resumable and idempotent, and must not report "done" until every store is confirmed clean — test this explicitly by simulating a MinIO failure mid-deletion.
- **Consent withdrawal mid-exam**: verify the system's actual behavior matches what the consent copy promised (if it says "withdrawing ends your proctored session," verify that's really what happens, not something milder or more severe by accident).
- **Backup taken during a period of high write load** (mid-exam): verify the backup mechanism doesn't degrade live performance unacceptably and that the resulting backup is still consistent (relevant to the DR restore test).
- **Two overlapping deletion requests for the same session** (e.g. retried admin action): idempotent — second request recognizes data is already gone, doesn't error confusingly.

---

## Definition of Done

- [ ] Consent flow live, blocking exam start without a valid `ConsentRecord`, versioned policy copy in place
- [ ] Deletion job tested end-to-end across all three stores (Postgres, MinIO, Redis ephemeral keys), including the partial-failure retry case
- [ ] Hold-window logic (deletion vs active investigation) implemented and tested
- [ ] DR restore test completed for real, actual RTO/RPO documented against agreed targets
- [ ] Cost review completed using real Phase 5 numbers, sizing adjustments documented
- [ ] All three incident runbooks reviewed by whoever will be on-call (not just written and filed)
- [ ] Architecture diagram + extension guides committed to `docs/`
- [ ] Handover doc reviewed with a Gridixa stakeholder, ownership boundaries explicit and agreed
- [ ] Minors/DPDP legal question explicitly resolved (answered yes with a plan, or confirmed not applicable) — not left open at launch
- [ ] `PROJECT_STATUS.md` updated — this closes the project as production-live, not just "deployed"
