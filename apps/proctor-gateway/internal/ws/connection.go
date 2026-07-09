package ws

import (
	"github.com/gofiber/contrib/websocket"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
)

// Connection represents the upgraded WebSocket connection
type Connection struct {
	ID   string
	Hub  *Hub
	Conn *websocket.Conn
	send chan []byte
}

// ServeWebSocket checks if upgrade headers are correct
func ServeWebSocket(hub *Hub) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if websocket.IsWebSocketUpgrade(c) {
			return c.Next()
		}
		return fiber.ErrUpgradeRequired
	}
}

// Handler handles websocket connections upgraded from Fiber
func Handler(hub *Hub) fiber.Handler {
	return websocket.New(func(c *websocket.Conn) {
		corrID, _ := c.Locals("correlationId").(string)
		connID := uuid.New().String()

		log.Info().
			Str("service", "proctor-gateway").
			Str("connId", connID).
			Str("correlationId", corrID).
			Msg("WebSocket client upgraded successfully")

		conn := &Connection{
			ID:   connID,
			Hub:  hub,
			Conn: c,
			send: make(chan []byte, 256),
		}

		hub.register <- conn

		defer func() {
			hub.unregister <- conn
			c.Close()
		}()

		// Read loop: simple echo stub for Phase 1
		for {
			messageType, message, err := c.ReadMessage()
			if err != nil {
				log.Info().
					Str("service", "proctor-gateway").
					Str("connId", connID).
					Err(err).
					Msg("WebSocket connection closed by client")
				break
			}

			// Trace with correlation ID
			log.Info().
				Str("service", "proctor-gateway").
				Str("connId", connID).
				Str("correlationId", corrID).
				Msg("Received WS frame telemetry stub")

			// Echo back payload to client
			if err := c.WriteMessage(messageType, message); err != nil {
				log.Error().
					Str("service", "proctor-gateway").
					Str("connId", connID).
					Err(err).
					Msg("Failed to echo WebSocket frame")
				break
			}
		}
	})
}
