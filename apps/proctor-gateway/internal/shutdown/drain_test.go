package shutdown

import (
	"os"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/stretchr/testify/assert"
	"proctor-gateway/internal/registry"
	"proctor-gateway/internal/ws"
)

func TestShutdownDraining(t *testing.T) {
	app := fiber.New()
	presence := registry.NewPresenceRegistry(nil)
	hub := ws.NewHub(nil, presence, nil)

	ListenForShutdown(app, hub)

	// Trigger shutdown by sending mock signal directly to channel
	shutdownChan <- os.Interrupt

	// Wait a moment for goroutine to pick it up
	time.Sleep(100 * time.Millisecond)

	assert.True(t, ws.Draining)

	// Clean up draining state
	ws.Draining = false
}
