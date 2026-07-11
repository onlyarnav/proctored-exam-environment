package shutdown

import (
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"
	"proctor-gateway/internal/ws"
)

// Draining indicates whether the gateway is shutting down and rejecting new connections
var Draining bool = false

var shutdownChan = make(chan os.Signal, 1)

// ListenForShutdown sets up signal handlers for graceful SIGINT and SIGTERM connection draining
func ListenForShutdown(app *fiber.App, hub *ws.Hub) {
	signal.Notify(shutdownChan, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		sig := <-shutdownChan
		log.Info().Str("signal", sig.String()).Msg("Shutdown signal received")

		// 1. Start draining, causing new upgrades to fail with 503
		Draining = true
		log.Info().Msg("Server is now draining. Rejecting new WebSocket upgrades with 503")

		// 2. Allow existing connections to drain for 15 seconds
		drainTimeout := 15 * time.Second
		log.Info().Msgf("Waiting %v for existing connections to drain...", drainTimeout)
		time.Sleep(drainTimeout)

		// 3. Close remaining active connections cleanly
		log.Info().Msg("Closing all remaining active connections...")
		hub.CloseAll()

		// 4. Shutdown the Fiber server
		log.Info().Msg("Shutting down HTTP server...")
		if err := app.Shutdown(); err != nil {
			log.Error().Err(err).Msg("Error shutting down HTTP server")
		}
	}()
}
