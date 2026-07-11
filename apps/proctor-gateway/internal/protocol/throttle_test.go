package protocol

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestFrameLimiter(t *testing.T) {
	// Refill 2 tokens per second, capacity 2.
	fl := NewFrameLimiter(2.0, 2.0)

	// Can burst 2 immediately
	assert.True(t, fl.Allow())
	assert.True(t, fl.Allow())

	// Third one should be blocked
	assert.False(t, fl.Allow())

	// Wait 550ms, should allow 1
	time.Sleep(550 * time.Millisecond)
	assert.True(t, fl.Allow())
	assert.False(t, fl.Allow())
}

func TestEventLimiter(t *testing.T) {
	// Max 3 events per 100ms
	el := NewEventLimiter(3, 100*time.Millisecond)

	// First 3 allowed
	allow, marker := el.Check()
	assert.True(t, allow)
	assert.False(t, marker)

	allow, marker = el.Check()
	assert.True(t, allow)
	assert.False(t, marker)

	allow, marker = el.Check()
	assert.True(t, allow)
	assert.False(t, marker)

	// 4th event crosses threshold -> allow is true, marker is true
	allow, marker = el.Check()
	assert.True(t, allow)
	assert.True(t, marker)

	// 5th event is dropped completely -> allow is false, marker is false
	allow, marker = el.Check()
	assert.False(t, allow)
	assert.False(t, marker)

	// Wait 110ms for window to reset
	time.Sleep(110 * time.Millisecond)

	// Next event after window reset is allowed
	allow, marker = el.Check()
	assert.True(t, allow)
	assert.False(t, marker)
}
