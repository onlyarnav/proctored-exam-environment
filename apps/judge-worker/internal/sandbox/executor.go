package sandbox

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"judge-worker/internal/runner"
)

type ExecutionResult struct {
	Output    string
	RuntimeMs int64
	Passed    bool
	Error     string
}

func Execute(lr runner.LanguageRunner, code string, input string) (*ExecutionResult, error) {
	// Create host temporary directory for mounting
	tempDir, err := os.MkdirTemp("", "judge-exec-*")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp dir: %w", err)
	}
	defer os.RemoveAll(tempDir) // Ensure host temp dir cleanup

	// Write code file to host tempDir
	codeFilePath := filepath.Join(tempDir, lr.CodeFileName())
	if err := os.WriteFile(codeFilePath, []byte(code), 0644); err != nil {
		return nil, fmt.Errorf("failed to write code file: %w", err)
	}

	// Prepare Docker execution command
	dockerArgs := []string{
		"run",
		"--rm",                 // Clean up container afterwards
		"--network=none",        // Network isolation
		"-m", "128m",           // Memory cap
		"--memory-swap=128m",   // Disable swap
		"--cpus=0.5",           // CPU limitation
		"--pids-limit=20",      // Prevent fork bomb
		"--read-only",          // Read-only root
		"--tmpfs", "/tmp:rw,noexec,nosuid,size=10m", // Memory-backed capped /tmp
		"-v", fmt.Sprintf("%s:/app:ro", tempDir),   // Mount host folder read-only to /app
	}

	// Build command based on runner image
	var cmdArgs []string
	if lr.Image() == "openjdk:21-slim" {
		cmdArgs = []string{"sh", "-c", "cp /app/Solution.java /tmp/Solution.java && java /tmp/Solution.java"}
	} else if lr.Image() == "python:3.12-slim" {
		cmdArgs = []string{"python", "/app/solution.py"}
	} else if lr.Image() == "node:20-alpine" {
		cmdArgs = []string{"node", "/app/solution.js"}
	} else if lr.Image() == "gcc:13" {
		cmdArgs = []string{"sh", "-c", "g++ -O2 -o /tmp/solution /app/solution.cpp && /tmp/solution"}
	} else {
		cmdArgs = lr.BuildCommand(code)
	}

	dockerArgs = append(dockerArgs, lr.Image())
	dockerArgs = append(dockerArgs, cmdArgs...)

	// Configure context with timeout
	ctx, cancel := context.WithTimeout(context.Background(), lr.Timeout())
	defer cancel()

	cmd := exec.CommandContext(ctx, "docker", dockerArgs...)
	cmd.Stdin = strings.NewReader(input)

	var stdoutBuf, stderrBuf bytes.Buffer
	cmd.Stdout = &limitWriter{buf: &stdoutBuf, limit: 64 * 1024}
	cmd.Stderr = &limitWriter{buf: &stderrBuf, limit: 64 * 1024}

	startTime := time.Now()
	err = cmd.Run()
	runtime := time.Since(startTime)

	result := &ExecutionResult{
		RuntimeMs: runtime.Milliseconds(),
		Passed:    err == nil,
	}

	stdoutStr := stdoutBuf.String()
	stderrStr := stderrBuf.String()

	if ctx.Err() == context.DeadlineExceeded {
		result.Passed = false
		result.Error = "TIMEOUT"
		result.Output = stdoutStr + "\n" + stderrStr + "\n[Execution Timed Out]"
	} else if err != nil {
		result.Passed = false
		if _, ok := err.(*exec.ExitError); ok {
			result.Error = "RUNTIME_ERROR"
			result.Output = stdoutStr + "\n" + stderrStr + "\n[Execution Failed]"
		} else {
			result.Error = "JUDGE_UNAVAILABLE"
			result.Output = fmt.Sprintf("System Error: %s", err.Error())
		}
	} else {
		result.Output = stdoutStr
	}

	return result, nil
}

type limitWriter struct {
	buf   *bytes.Buffer
	limit int
	count int
}

func (lw *limitWriter) Write(p []byte) (n int, err error) {
	if lw.count >= lw.limit {
		return len(p), nil
	}
	remaining := lw.limit - lw.count
	if len(p) > remaining {
		n, err = lw.buf.Write(p[:remaining])
		lw.count += n
		return len(p), err
	}
	n, err = lw.buf.Write(p)
	lw.count += n
	return n, err
}
