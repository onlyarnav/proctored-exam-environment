package runner

import "time"

type LanguageRunner interface {
	Image() string
	CodeFileName() string
	BuildCommand(code string) []string
	MaxMemoryMB() int
	MaxCPUShares() int
	Timeout() time.Duration
}

type BaseRunner struct {
	image        string
	codeFileName string
	timeout      time.Duration
}

func (b *BaseRunner) Image() string          { return b.image }
func (b *BaseRunner) CodeFileName() string  { return b.codeFileName }
func (b *BaseRunner) MaxMemoryMB() int       { return 128 }
func (b *BaseRunner) MaxCPUShares() int      { return 512 }
func (b *BaseRunner) Timeout() time.Duration { return b.timeout }

// Python Runner
type PythonRunner struct {
	BaseRunner
}

func NewPythonRunner() *PythonRunner {
	return &PythonRunner{
		BaseRunner: BaseRunner{
			image:        "python:3.12-slim",
			codeFileName: "solution.py",
			timeout:      2 * time.Second,
		},
	}
}

func (p *PythonRunner) BuildCommand(code string) []string {
	return []string{"python", "/tmp/solution.py"}
}

// JavaScript Runner
type JavaScriptRunner struct {
	BaseRunner
}

func NewJavaScriptRunner() *JavaScriptRunner {
	return &JavaScriptRunner{
		BaseRunner: BaseRunner{
			image:        "node:20-alpine",
			codeFileName: "solution.js",
			timeout:      2 * time.Second,
		},
	}
}

func (j *JavaScriptRunner) BuildCommand(code string) []string {
	return []string{"node", "/tmp/solution.js"}
}

// C++ Runner
type CppRunner struct {
	BaseRunner
}

func NewCppRunner() *CppRunner {
	return &CppRunner{
		BaseRunner: BaseRunner{
			image:        "gcc:13",
			codeFileName: "solution.cpp",
			timeout:      4 * time.Second,
		},
	}
}

func (c *CppRunner) BuildCommand(code string) []string {
	return []string{"sh", "-c", "g++ -O2 -o /tmp/solution /tmp/solution.cpp && /tmp/solution"}
}

// Java Runner
type JavaRunner struct {
	BaseRunner
}

func NewJavaRunner() *JavaRunner {
	return &JavaRunner{
		BaseRunner: BaseRunner{
			image:        "openjdk:21-slim",
			codeFileName: "Solution.java",
			timeout:      4 * time.Second,
		},
	}
}

func (j *JavaRunner) BuildCommand(code string) []string {
	return []string{"java", "/tmp/Solution.java"}
}
