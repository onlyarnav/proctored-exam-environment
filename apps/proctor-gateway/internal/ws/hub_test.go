package ws

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"proctor-gateway/internal/registry"
)

func TestHub_RegisterAndUnregisterCleanly(t *testing.T) {
	presence := registry.NewPresenceRegistry(nil)
	hub := NewHub(nil, presence, nil)

	conn := &Connection{
		ID:        "conn_1",
		SessionID: "session_123",
	}

	hub.Register(conn)
	assert.True(t, hub.IsSessionConnected("session_123"))

	// Unregister cleanly
	hub.Unregister(conn, true)
	assert.False(t, hub.IsSessionConnected("session_123"))

	info, err := presence.GetPresence("session_123")
	assert.NoError(t, err)
	assert.Nil(t, info)
}

func TestHub_UnregisterUnexpectedly_GracePeriod(t *testing.T) {
	presence := registry.NewPresenceRegistry(nil)
	hub := NewHub(nil, presence, nil)
	hub.graceWindow = 100 * time.Millisecond // short window for testing

	conn := &Connection{
		ID:        "conn_1",
		SessionID: "session_123",
	}

	hub.Register(conn)
	assert.True(t, hub.IsSessionConnected("session_123"))

	// Unregister unexpectedly -> starts grace period
	hub.Unregister(conn, false)

	// Session is STILL tracked in hub (but state in presence is disconnected)
	h, ok := hub.connections["session_123"]
	assert.True(t, ok)
	assert.Equal(t, conn, h)

	info, err := presence.GetPresence("session_123")
	assert.NoError(t, err)
	assert.Equal(t, "disconnected", info.State)

	// Wait for grace window to expire
	time.Sleep(150 * time.Millisecond)

	// Now it should be cleaned up
	assert.False(t, hub.IsSessionConnected("session_123"))
	h, ok = hub.connections["session_123"]
	assert.False(t, ok)

	info, err = presence.GetPresence("session_123")
	assert.NoError(t, err)
	assert.Nil(t, info)
}

func TestHub_GracePeriodReconnect(t *testing.T) {
	presence := registry.NewPresenceRegistry(nil)
	hub := NewHub(nil, presence, nil)
	hub.graceWindow = 200 * time.Millisecond

	conn1 := &Connection{
		ID:        "conn_1",
		SessionID: "session_123",
	}

	hub.Register(conn1)

	// Unexpected disconnect
	hub.Unregister(conn1, false)

	// Reconnect inside grace window
	conn2 := &Connection{
		ID:        "conn_2",
		SessionID: "session_123",
	}
	hub.Register(conn2)

	// Verify state is connected again and conn2 is in hub
	assert.True(t, hub.IsSessionConnected("session_123"))
	assert.Equal(t, conn2, hub.GetConnection("session_123"))

	info, err := presence.GetPresence("session_123")
	assert.NoError(t, err)
	assert.Equal(t, "connected", info.State)

	// Wait past the original grace period to verify no expiry happened
	time.Sleep(250 * time.Millisecond)

	// Should still be connected
	assert.True(t, hub.IsSessionConnected("session_123"))
	assert.Equal(t, conn2, hub.GetConnection("session_123"))
}
