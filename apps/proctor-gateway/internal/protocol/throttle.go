package protocol

import (
	"sync"
	"time"
)

// FrameLimiter implements a token-bucket rate limiter for webcam frames
type FrameLimiter struct {
	mu           sync.Mutex
	capacity     float64
	tokens       float64
	refillRate   float64
	lastRefilled time.Time
}

// NewFrameLimiter creates a new FrameLimiter.
// refillRate is tokens per second (e.g. 0.5 for 1 frame every 2 seconds).
// capacity is the maximum burst size (e.g. 2).
func NewFrameLimiter(refillRate, capacity float64) *FrameLimiter {
	return &FrameLimiter{
		capacity:     capacity,
		tokens:       capacity,
		refillRate:   refillRate,
		lastRefilled: time.Now(),
	}
}

// Allow checks if a frame is allowed under the rate limit. If allowed, it consumes a token.
func (fl *FrameLimiter) Allow() bool {
	fl.mu.Lock()
	defer fl.mu.Unlock()

	now := time.Now()
	elapsed := now.Sub(fl.lastRefilled).Seconds()
	fl.lastRefilled = now

	// Refill tokens
	fl.tokens += elapsed * fl.refillRate
	if fl.tokens > fl.capacity {
		fl.tokens = fl.capacity
	}

	if fl.tokens >= 1.0 {
		fl.tokens -= 1.0
		return true
	}

	return false
}

// EventLimiter caps the number of integrity events allowed in a rolling window.
type EventLimiter struct {
	mu          sync.Mutex
	window      time.Duration
	maxEvents   int
	windowStart time.Time
	count       int
}

// NewEventLimiter creates a new EventLimiter (e.g., max 20 events per 10s).
func NewEventLimiter(maxEvents int, window time.Duration) *EventLimiter {
	return &EventLimiter{
		window:      window,
		maxEvents:   maxEvents,
		windowStart: time.Now(),
		count:       0,
	}
}

// Check checks the incoming event.
// Returns (allow, shouldEmitRateExceededMarker).
// - allow: true if the event should be processed.
// - shouldEmitRateExceededMarker: true if this is the transition point where we exceed the rate limit
//   and should write a single EVENT_RATE_EXCEEDED marker downstream.
func (el *EventLimiter) Check() (bool, bool) {
	el.mu.Lock()
	defer el.mu.Unlock()

	now := time.Now()
	if now.Sub(el.windowStart) >= el.window {
		el.windowStart = now
		el.count = 1
		return true, false
	}

	el.count++
	if el.count <= el.maxEvents {
		return true, false
	}

	// If we just crossed the threshold, return true for allow (so the marker is written)
	// and true for shouldEmitRateExceededMarker.
	if el.count == el.maxEvents+1 {
		return true, true
	}

	// Otherwise, drop
	return false, false
}
