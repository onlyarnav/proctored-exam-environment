# Phase 2 — Core Exam Engine

**Goal:** A working (non-proctored yet) exam flow end to end: admin creates an exam with MCQ + coding questions, a student takes it within a server-enforced time window, coding submissions run in an isolated sandbox, results are computed correctly under concurrency and adversarial input.

---

## Scope

- Question bank: MCQ and coding-problem types, tagged by topic/difficulty
- Exam entity: composed of questions, has a time window + duration, assigned to candidates
- Exam session state machine: `NOT_STARTED → IN_PROGRESS → SUBMITTED → GRADED`, enforced server-side with no invalid transitions possible
- Code execution sandbox (`judge-worker`) wired to real submissions, hardened per the malicious-code edge cases in `CLAUDE.md` §3.3
- Auto-grading for MCQ; sandboxed test-case execution + weighted scoring for coding questions
- Results view (student) + results dashboard (admin)
- Autosave for in-progress answers (protects against the browser-crash-mid-exam edge case)

---

## Data model additions (Prisma)

```prisma
enum QuestionType {
  MCQ
  CODE
}

model Question {
  id           String       @id @default(uuid())
  type         QuestionType
  prompt       String
  options      Json?         // MCQ only: [{id, text}]
  correctOption String?       // MCQ only: option id
  starterCode  Json?          // CODE only: { python: "...", cpp: "...", ... }
  testCases    Json?          // CODE only: [{ input, expectedOutput, isPublic }]
  points       Int
  topic        String?
  difficulty   String?
  createdAt    DateTime     @default(now())

  @@index([type])
}

model Exam {
  id              String   @id @default(uuid())
  title           String
  description     String?
  startsAt        DateTime
  endsAt          DateTime
  durationMinutes Int
  createdBy       String
  createdAt       DateTime @default(now())
  questions       ExamQuestion[]
  sessions        ExamSession[]
}

model ExamQuestion {
  examId     String
  questionId String
  order      Int
  points     Int            // per-exam override; falls back to Question.points if not set
  exam       Exam     @relation(fields: [examId], references: [id])
  question   Question @relation(fields: [questionId], references: [id])

  @@id([examId, questionId])
}

enum SessionStatus {
  NOT_STARTED
  IN_PROGRESS
  SUBMITTED
  GRADED
}

model ExamSession {
  id           String        @id @default(uuid())
  examId       String
  userId       String
  status       SessionStatus @default(NOT_STARTED)
  startedAt    DateTime?
  submittedAt  DateTime?
  score        Float?
  exam         Exam          @relation(fields: [examId], references: [id])
  submissions  Submission[]

  @@unique([examId, userId])   // one session per candidate per exam — enforces the single-active-session rule at the DB level
}

model Submission {
  id           String     @id @default(uuid())
  sessionId    String
  questionId   String
  answer       Json        // MCQ: { selectedOption }, CODE: { language, code }
  autoScore    Float?
  gradedAt     DateTime?
  idempotencyKey String?  @unique   // dedupes retried submit calls
  createdAt    DateTime   @default(now())
  session      ExamSession @relation(fields: [sessionId], references: [id])

  @@unique([sessionId, questionId])   // one submission per question per session — resubmits UPDATE, not INSERT
}
```

**Design notes:**
- `ExamSession` unique on `(examId, userId)` — the DB itself prevents two concurrent sessions for the same candidate/exam, closing the duplicate-tab edge case at the data layer rather than relying purely on application logic.
- `Submission` unique on `(sessionId, questionId)` — a resubmit for the same question is an upsert, never a duplicate row; combined with `idempotencyKey`, this closes both the "double-click submit" and "retried network request" edge cases from `CLAUDE.md` §3.1/§4.4.
- Hidden test cases (`isPublic: false`) are never sent to the client — the API layer strips them from any response reaching `apps/web`; only pass/fail + public test case results are visible to the candidate before grading is final.

---

## Exam session state machine — enforced transitions

```
NOT_STARTED --start()--> IN_PROGRESS --submit() or auto-submit-on-timeout--> SUBMITTED --grading complete--> GRADED
```

- `start()`: only valid from `NOT_STARTED`, only within `[startsAt, endsAt]`, sets `startedAt = now()`. Wrapped in a DB transaction with row-level locking to prevent the race in `CLAUDE.md` §3.4 (auto-submit-on-timeout firing at the same instant as a manual submit).
- `submit()`: only valid from `IN_PROGRESS`. Server independently verifies `now() <= startedAt + durationMinutes` AND `now() <= exam.endsAt` — a submit arriving after either boundary is rejected with `409 SESSION_EXPIRED`, never silently accepted or silently dropped.
- Auto-submit-on-timeout: a scheduled job (or gateway-driven check, decide based on Phase 3 integration) transitions any `IN_PROGRESS` session past its deadline to `SUBMITTED` even if the candidate never clicks submit — must use the same locking as manual submit to avoid double-processing.
- Any transition attempted outside this graph (e.g., `submit()` on a `NOT_STARTED` session, or a second `start()` on an `IN_PROGRESS` one) returns a clean `409 INVALID_SESSION_TRANSITION`, never a silent no-op or a 500.

---

## judge-worker design — full detail

**Job schema** (pushed to Redis by `apps/api` on submission):
```json
{
  "submissionId": "uuid",
  "language": "python|javascript|java|cpp",
  "code": "...",
  "testCases": [{ "input": "...", "expectedOutput": "..." }],
  "idempotencyKey": "uuid",
  "correlationId": "..."
}
```

**`LanguageRunner` interface** (Go):
```go
type LanguageRunner interface {
    Image() string                          // e.g. "python:3.12-slim" pinned digest, not floating tag
    BuildCommand(code string) []string       // how to invoke the code inside the container
    MaxMemoryMB() int
    MaxCPUShares() int
    Timeout() time.Duration
}
```
One concrete implementation per language (`PythonRunner`, `JavaRunner`, `CppRunner`, `JavaScriptRunner`) — adding a fifth language later is a new file implementing this interface, not a change to the pipeline (strategy pattern per `CLAUDE.md` §1.4).

**Execution pipeline per submission:**
1. Pull job from Redis queue (worker pool, configurable concurrency).
2. Validate `language` against the supported set and basic payload sanity **before** touching Docker — reject unsupported/malformed submissions immediately (§3.3 edge case).
3. Spin an ephemeral container: `--network none`, `--memory <cap>`, `--cpus <cap>`, `--pids-limit <cap>`, read-only root filesystem + small size-capped `--tmpfs` for scratch writes.
4. Run each test case with a hard wall-clock timeout; on timeout, `SIGKILL` the process, mark that test case failed with `TIMEOUT`, continue to next test case (one slow test case shouldn't abort the whole submission's grading).
5. Capture stdout/stderr truncated at a fixed byte cap (e.g. 64KB) regardless of how much the program actually printed — prevents the huge-stdout edge case from OOMing the worker.
6. **Always** remove the container in a `defer`/cleanup path that runs whether the run succeeded, failed, or the worker itself errored — no leaked containers, ever, at 1000-candidate scale this matters for host resource exhaustion.
7. Write result back: per-test-case pass/fail, total weighted score, truncated output, runtime ms, to `Submission.autoScore` + a `SubmissionResult` detail record.
8. If the container fails to even start (Docker daemon issue, image pull failure): this is a system fault, not a candidate fault — mark the submission `JUDGE_UNAVAILABLE` and requeue with backoff, never record it as a scored failure (§3.3 edge case).

**Grading:**
- MCQ: trivial exact-match compare against `correctOption`.
- Coding: weighted pass rate across test cases — `autoScore = points * (passed_test_cases / total_test_cases)`, hidden test cases count toward the score but their input/expected output are never exposed to the candidate, before or after grading (only pass/fail per case, and only for public cases is the actual expected output ever shown).

---

## Frontend (`apps/web`) — exam-taking UI detail

- Question navigator with per-question answered/unanswered/flagged-for-review status.
- **Autosave**: every answer change (MCQ selection, code edit debounced ~2s) PATCHes the draft answer to the server — this is separate from final `submit()`, and its own idempotent, retryable call; a browser crash mid-exam should lose at most the last few seconds of typing, never the whole session (closes the browser-crash edge case from `CLAUDE.md` §3.1).
- Timer: countdown rendered from server-provided `endsAt`/`startedAt + durationMinutes` (whichever is sooner), re-synced from the server periodically (not purely client `setInterval` drift) — client clock is never trusted for the actual deadline enforcement, only for display.
- Code editor: Monaco, language selector limited to the supported set, starter code pre-filled per selected language.
- Submit confirmation: explicit "are you sure" for the final submit action, distinct from autosave — but final submit itself is idempotent (§4.4), so a double-click or a retried request after a flaky network response doesn't double-submit or error confusingly.

---

## Edge cases — must be handled and tested this phase

(Builds on the general catalog in `CLAUDE.md` §3.1/§3.3 — this section is the phase-specific implementation guidance.)

- **Submit exactly at the deadline boundary**: explicit test at `now() == endsAt` and `now() == endsAt + 1ms`.
- **Two simultaneous submit attempts for the same session** (manual click + auto-submit-on-timeout racing): only one should win, the other should get a clean `409`, never both processed.
- **Resubmit for the same question**: upsert behavior verified — second submission for `(sessionId, questionId)` updates the existing row, doesn't create a duplicate or error.
- **Malicious code**: each of fork bomb, network exfiltration attempt, disk-fill attempt, infinite loop, huge-stdout — explicit test per case, per `CLAUDE.md` §3.3, asserting the sandbox contains it and the worker survives to process the next job.
- **judge-worker crash mid-job**: the job must not be silently lost — either the consumer group's at-least-once redelivery picks it up again (with idempotency preventing double-scoring) or it's explicitly requeued.
- **Exam edited by admin while sessions are in progress**: per the decision recorded in `PROJECT_STATUS.md` (recommended default: snapshot at session start) — test that an in-progress session's questions/points don't shift under the candidate mid-exam.
- **Autosave PATCH arriving out of order** (e.g., a slow request from 10s ago landing after a newer one): last-write-wins by server-received timestamp, not client-sent timestamp, to avoid an old draft overwriting a newer one.

---

## Testing requirements

- **NestJS**: unit tests for exam/session state machine transitions (every valid and invalid transition in the graph above); integration tests against a real test-container Postgres for the unique-constraint-enforced duplicate-session and duplicate-submission cases.
- **judge-worker (Go)**: `go test ./... -race`; explicit adversarial test suite (fork bomb, network attempt, disk fill, infinite loop, huge stdout) run against the real Docker sandbox, not mocked — these tests are slow, keep them in a separate `adversarial` build tag/CI job if needed rather than skipping them.
- **Load smoke test**: 50 concurrent sessions submitting simultaneously (both MCQ and coding) without data loss or race conditions on session state — full 1000-scale validation is Phase 5, but this phase must prove correctness under modest concurrency first.

---

## Definition of Done

- [ ] Admin can create an exam mixing MCQ + coding questions and assign it to test candidates
- [ ] Student can start, autosave answers, and submit within the enforced time window; server rejects submissions after the deadline in both directions of the boundary test
- [ ] `ExamSession` and `Submission` uniqueness constraints proven to prevent duplicate sessions/submissions under concurrent/retried requests
- [ ] Coding submissions execute in an isolated container; every adversarial test in the malicious-code suite passes (sandbox contains the attempt, worker survives)
- [ ] Hidden test case data never appears in any API response reaching the candidate, verified by test, not just code review
- [ ] MCQ and coding scores roll up correctly into session score, visible to admin and (post-grading) to the student
- [ ] 50-concurrent-session smoke test passes with no data loss or race conditions
- [ ] `PROJECT_STATUS.md` updated
