package sandbox

import (
	"strings"
	"testing"
	"judge-worker/internal/runner"
)

func TestAdversarial_InfiniteLoop(t *testing.T) {
	pr := runner.NewPythonRunner()
	// Python infinite loop code
	code := `
import time
while True:
    time.sleep(0.1)
`
	res, err := Execute(pr, code, "")
	if err != nil {
		t.Fatalf("Failed to execute: %v", err)
	}

	if res.Passed {
		t.Error("Expected execution to fail due to timeout, but it passed")
	}
	if res.Error != "TIMEOUT" {
		t.Errorf("Expected Error to be TIMEOUT, got %s", res.Error)
	}
	if !strings.Contains(res.Output, "[Execution Timed Out]") {
		t.Errorf("Expected output to mention timeout, got: %s", res.Output)
	}
}

func TestAdversarial_ForkBomb(t *testing.T) {
	pr := runner.NewPythonRunner()
	// Python fork bomb code
	code := `
import os
import time
for i in range(100):
    try:
        os.fork()
    except Exception as e:
        pass
time.sleep(0.5)
print("Finished")
`
	res, err := Execute(pr, code, "")
	if err != nil {
		t.Fatalf("Failed to execute: %v", err)
	}

	// The process limits should catch it or terminate with error, or it runs and is restricted.
	// We want to make sure it doesn't hang the host and finishes/exits.
	t.Logf("Fork bomb output: %s, Error: %s, Passed: %v", res.Output, res.Error, res.Passed)
}

func TestAdversarial_DiskFill(t *testing.T) {
	pr := runner.NewPythonRunner()
	// Python disk fill code trying to write large file to /tmp
	code := `
try:
    with open('/tmp/huge.txt', 'w') as f:
        for i in range(20 * 1024): # Try writing 20MB (limit is 10MB)
            f.write('A' * 1024)
    print("Success")
except Exception as e:
    print(f"WRITE_FAILED: {e}")
`
	res, err := Execute(pr, code, "")
	if err != nil {
		t.Fatalf("Failed to execute: %v", err)
	}

	if strings.Contains(res.Output, "Success") {
		t.Error("Expected disk fill to fail due to 10MB tmpfs limit, but it reported Success")
	}
	if !strings.Contains(res.Output, "WRITE_FAILED") && res.Error != "RUNTIME_ERROR" {
		t.Errorf("Expected write to fail with out of space error, got output: %s, error: %s", res.Output, res.Error)
	}
}

func TestAdversarial_NetworkExfiltration(t *testing.T) {
	pr := runner.NewPythonRunner()
	// Python code attempting network access
	code := `
import urllib.request
try:
    urllib.request.urlopen("http://example.com", timeout=1)
    print("NET_SUCCESS")
except Exception as e:
    print(f"NET_FAILED: {e}")
`
	res, err := Execute(pr, code, "")
	if err != nil {
		t.Fatalf("Failed to execute: %v", err)
	}

	if strings.Contains(res.Output, "NET_SUCCESS") {
		t.Error("Expected network call to fail, but it succeeded")
	}
	if !strings.Contains(res.Output, "NET_FAILED") {
		t.Errorf("Expected output to report connection failure, got: %s", res.Output)
	}
}

func TestAdversarial_HugeStdout(t *testing.T) {
	pr := runner.NewPythonRunner()
	// Python code printing infinite lines
	code := `
import sys
for i in range(100000):
    sys.stdout.write("A" * 100 + "\n")
`
	res, err := Execute(pr, code, "")
	if err != nil {
		t.Fatalf("Failed to execute: %v", err)
	}

	outputSize := len(res.Output)
	maxCap := 65 * 1024 // 65KB
	if outputSize > maxCap {
		t.Errorf("Expected stdout to be truncated at 64KB, but output size was %d bytes", outputSize)
	}
	t.Logf("Truncated output size: %d bytes", outputSize)
}
