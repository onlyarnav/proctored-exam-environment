package registry

import (
	"context"
	"testing"

	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
)

func TestPresenceRegistry_InMemory(t *testing.T) {
	pr := NewPresenceRegistry(nil)

	// Set presence
	pr.SetPresence("session_123", "connected")

	info, err := pr.GetPresence("session_123")
	assert.NoError(t, err)
	assert.NotNil(t, info)
	assert.Equal(t, "connected", info.State)
	assert.Equal(t, "pod-default", info.PodID)

	// Update presence to degraded
	pr.SetPresence("session_123", "degraded")
	info, err = pr.GetPresence("session_123")
	assert.NoError(t, err)
	assert.Equal(t, "degraded", info.State)

	// GetAll
	all, err := pr.GetAllPresence()
	assert.NoError(t, err)
	assert.Len(t, all, 1)
	assert.Equal(t, "degraded", all["session_123"].State)

	// Remove
	pr.RemovePresence("session_123")
	info, err = pr.GetPresence("session_123")
	assert.NoError(t, err)
	assert.Nil(t, info)
}

func TestPresenceRegistry_WithRedis(t *testing.T) {
	// Attempt connection to local real Redis
	rdb := redis.NewClient(&redis.Options{
		Addr: "127.0.0.1:6379",
	})
	ctx := context.Background()
	// Ping to see if it's reachable; if not, skip this test
	if err := rdb.Ping(ctx).Err(); err != nil {
		t.Skip("Redis is not available on localhost:6379, skipping integration test")
	}
	defer rdb.Close()

	// Clear test key before starting
	rdb.HDel(ctx, "proctor:presence", "session_test_456")

	pr := NewPresenceRegistry(rdb)

	pr.SetPresence("session_test_456", "connected")

	info, err := pr.GetPresence("session_test_456")
	assert.NoError(t, err)
	assert.NotNil(t, info)
	assert.Equal(t, "connected", info.State)

	all, err := pr.GetAllPresence()
	assert.NoError(t, err)
	assert.Contains(t, all, "session_test_456")
	assert.Equal(t, "connected", all["session_test_456"].State)

	pr.SetPresence("session_test_456", "disconnected")
	info, err = pr.GetPresence("session_test_456")
	assert.NoError(t, err)
	assert.Equal(t, "disconnected", info.State)
	assert.True(t, !info.DisconnectedAt.IsZero())

	pr.RemovePresence("session_test_456")
	info, err = pr.GetPresence("session_test_456")
	assert.NoError(t, err)
	assert.Nil(t, info)
}
