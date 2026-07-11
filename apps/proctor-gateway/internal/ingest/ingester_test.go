package ingest

import (
	"context"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
)

func TestIngester_Publish(t *testing.T) {
	rdb := redis.NewClient(&redis.Options{
		Addr: "127.0.0.1:6379",
	})
	ctx := context.Background()
	// Skip if Redis is not reachable
	if err := rdb.Ping(ctx).Err(); err != nil {
		t.Skip("Redis is not available on 127.0.0.1:6379, skipping integration test")
	}
	defer rdb.Close()

	// Clear streams
	rdb.Del(ctx, "proctor:frames", "proctor:events")

	ing := NewIngester(rdb)

	// Test PublishFrame
	now := time.Now().UnixMilli()
	err := ing.PublishFrame("session_123", "frame_1", now, now-100, "corr_123", []byte("jpeg_bytes"))
	assert.NoError(t, err)

	frames, err := rdb.XRange(ctx, "proctor:frames", "-", "+").Result()
	assert.NoError(t, err)
	assert.Len(t, frames, 1)
	assert.Equal(t, "session_123", frames[0].Values["sessionId"])
	assert.Equal(t, "jpeg_bytes", frames[0].Values["data"])

	// Test PublishEvent
	err = ing.PublishEvent("session_123", "event_1", "TAB_BLUR", now, now-100, "corr_123")
	assert.NoError(t, err)

	events, err := rdb.XRange(ctx, "proctor:events", "-", "+").Result()
	assert.NoError(t, err)
	assert.Len(t, events, 1)
	assert.Equal(t, "TAB_BLUR", events[0].Values["eventType"])
}
