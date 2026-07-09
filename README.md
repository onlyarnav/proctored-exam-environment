# Proctored AI Olympiad Exam Platform

A highly scalable, multi-service proctored online exam platform supporting 1000 concurrent sessions.

## Project Structure

- `apps/api`: NestJS Core API (authentication, exam sessions, grading)
- `apps/web`: Next.js Candidate Portal & Admin Dashboard
- `apps/proctor-gateway`: Go WebSocket Proctoring Gateway (telemetry & frame ingestion)
- `apps/ml-service`: Python FastAPI ML/CV Flagging Service
- `apps/judge-worker`: Go Sandboxed Code Execution Worker
- `packages/shared-types`: Shared TypeScript typings
- `infra`: Docker Compose infrastructure configurations
