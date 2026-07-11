package ws

import (
	"encoding/json"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gofiber/contrib/websocket"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
	"proctor-gateway/internal/authz"
	"proctor-gateway/internal/ingest"
	"proctor-gateway/internal/protocol"
	"proctor-gateway/internal/registry"
)

// BufferedTelemetry stores telemetry data temporarily when Redis is unavailable
type BufferedTelemetry struct {
	IsFrame   bool
	ID        string // frameId or eventId
	Type      string // eventType (only for events)
	Payload   []byte // JPEG bytes
	ClientTS  int64
	Timestamp int64  // server timestamp
}

// Connection represents the upgraded WebSocket connection
type Connection struct {
	ID            string
	SessionID     string
	UserID        string
	ExamID        string
	CorrelationID string
	Hub           *Hub
	Conn          *websocket.Conn
	send          chan []byte
	frameLimiter  *protocol.FrameLimiter
	eventLimiter  *protocol.EventLimiter
	ingester      *ingest.Ingester
	presence      *registry.PresenceRegistry
	mu            sync.Mutex
	buffer        []BufferedTelemetry
	degraded      bool
	closeOnce     sync.Once
}

// ServeWebSocket performs handshake-time validation (Origin checks and JWT verification)
func ServeWebSocket(hub *Hub) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if !websocket.IsWebSocketUpgrade(c) {
			return fiber.ErrUpgradeRequired
		}

		// 1. Origin verification
		origin := c.Get("Origin")
		allowedStr := os.Getenv("ALLOWED_ORIGINS")
		if allowedStr != "" {
			allowedList := strings.Split(allowedStr, ",")
			allowed := false
			for _, o := range allowedList {
				if strings.TrimSpace(o) == "*" || strings.TrimSpace(o) == origin {
					allowed = true
					break
				}
			}
			if !allowed {
				log.Warn().Str("origin", origin).Msg("WebSocket upgrade rejected: Origin not allowed")
				return c.Status(fiber.StatusForbidden).SendString("Origin not allowed")
			}
		}

		// 2. Token verification
		token := c.Query("token")
		if token == "" {
			return c.Status(fiber.StatusUnauthorized).SendString("Missing token")
		}

		claims, err := authz.VerifyWSToken(token)
		if err != nil {
			log.Warn().Err(err).Msg("WebSocket upgrade rejected: Invalid token")
			return c.Status(fiber.StatusUnauthorized).SendString("Invalid token")
		}

		// Store claims in context locals for the handler
		c.Locals("claims", claims)
		c.Locals("correlationId", c.Locals("correlationId"))
		return c.Next()
	}
}

// Handler handles websocket connections upgraded from Fiber
func Handler(hub *Hub, ingester *ingest.Ingester, presence *registry.PresenceRegistry) fiber.Handler {
	return websocket.New(func(c *websocket.Conn) {
		corrID, _ := c.Locals("correlationId").(string)
		if corrID == "" {
			corrID = uuid.New().String()
		}

		claims, ok := c.Locals("claims").(*authz.Claims)
		if !ok {
			log.Error().Msg("WebSocket claims missing in upgraded connection")
			c.Close()
			return
		}

		// 3. Reject duplicate connections for active session
		if hub.IsSessionConnected(claims.SessionID) {
			log.Warn().
				Str("sessionId", claims.SessionID).
				Str("correlationId", corrID).
				Msg("Rejecting duplicate WS connection attempt")

			// Close with code 4001 (SESSION_ALREADY_CONNECTED)
			msg := websocket.FormatCloseMessage(4001, "SESSION_ALREADY_CONNECTED")
			_ = c.WriteMessage(websocket.CloseMessage, msg)
			c.Close()
			return
		}

		connID := uuid.New().String()
		conn := &Connection{
			ID:            connID,
			SessionID:     claims.SessionID,
			UserID:        claims.UserID,
			ExamID:        claims.ExamID,
			CorrelationID: corrID,
			Hub:           hub,
			Conn:          c,
			send:          make(chan []byte, 16), // bounded buffer to size 16
			frameLimiter:  protocol.NewFrameLimiter(0.5, 2.0), // 1 frame/2s (0.5 refills/sec) + burst of 2
			eventLimiter:  protocol.NewEventLimiter(20, 10*time.Second), // max 20 events per 10s
			ingester:      ingester,
			presence:      presence,
			buffer:        make([]BufferedTelemetry, 0),
		}

		hub.Register(conn)

		// Start reader and writer pumps
		go conn.writePump()
		conn.readPump()
	})
}

// Close closes the connection cleanly and unregisters it from the hub
func (conn *Connection) Close() {
	conn.closeOnce.Do(func() {
		log.Info().Str("sessionId", conn.SessionID).Str("connId", conn.ID).Msg("Closing WebSocket connection")
		// Clean up pumps
		if conn.Conn != nil {
			_ = conn.Conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
			_ = conn.Conn.Close()
		}
	})
}

func (conn *Connection) readPump() {
	defer func() {
		if r := recover(); r != nil {
			log.Error().
				Str("sessionId", conn.SessionID).
				Interface("panic", r).
				Msg("Recovered from readPump panic")
		}
		conn.Hub.Unregister(conn, false) // unregister unexpectedly unless explicitly closed
		conn.Close()
	}()

	conn.Conn.SetReadLimit(256 * 1024) // Cap frame size at 256KB to prevent memory exhaustion
	conn.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.Conn.SetPongHandler(func(string) error {
		conn.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		_, message, err := conn.Conn.ReadMessage()
		if err != nil {
			log.Info().
				Str("sessionId", conn.SessionID).
				Str("connId", conn.ID).
				Err(err).
				Msg("WebSocket connection closed")
			break
		}

		msgType, clientTS, payload, err := protocol.ParseMessage(message)
		if err != nil {
			log.Warn().
				Str("sessionId", conn.SessionID).
				Err(err).
				Msg("Failed to parse binary WS message; dropping frame")
			continue
		}

		if msgType == protocol.MessageTypeFrame {
			conn.handleFrame(clientTS, payload)
		} else if msgType == protocol.MessageTypeEvent {
			conn.handleEvent(clientTS, payload)
		}
	}
}

func (conn *Connection) writePump() {
	ticker := time.NewTicker(30 * time.Second)
	defer func() {
		if r := recover(); r != nil {
			log.Error().
				Str("sessionId", conn.SessionID).
				Interface("panic", r).
				Msg("Recovered from writePump panic")
		}
		ticker.Stop()
		conn.Close()
	}()

	for {
		select {
		case message, ok := <-conn.send:
			conn.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				return
			}
			if err := conn.Conn.WriteMessage(websocket.TextMessage, message); err != nil {
				log.Error().Str("sessionId", conn.SessionID).Err(err).Msg("Failed to write message")
				return
			}
		case <-ticker.C:
			conn.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				log.Error().Str("sessionId", conn.SessionID).Err(err).Msg("Failed to write Ping")
				return
			}
		}
	}
}

func (conn *Connection) handleFrame(clientTS uint64, payload []byte) {
	if !conn.frameLimiter.Allow() {
		// Throttled: drop silently
		return
	}

	frameID := uuid.New().String()
	serverTS := time.Now().UnixMilli()

	conn.processTelemetry(BufferedTelemetry{
		IsFrame:   true,
		ID:        frameID,
		Payload:   payload,
		ClientTS:  int64(clientTS),
		Timestamp: serverTS,
	})
}

func (conn *Connection) handleEvent(clientTS uint64, payload []byte) {
	var ie protocol.IntegrityEvent
	if err := json.Unmarshal(payload, &ie); err != nil {
		log.Warn().Str("sessionId", conn.SessionID).Err(err).Msg("Failed to unmarshal integrity event payload")
		return
	}

	allow, emitMarker := conn.eventLimiter.Check()
	if !allow {
		return
	}

	eventType := ie.EventType
	if emitMarker {
		eventType = "EVENT_RATE_EXCEEDED"
	}

	eventID := uuid.New().String()
	serverTS := time.Now().UnixMilli()

	conn.processTelemetry(BufferedTelemetry{
		IsFrame:   false,
		ID:        eventID,
		Type:      eventType,
		ClientTS:  int64(clientTS),
		Timestamp: serverTS,
	})
}

func (conn *Connection) processTelemetry(item BufferedTelemetry) {
	conn.mu.Lock()
	defer conn.mu.Unlock()

	// If already degraded and we have a buffer, try to buffer directly if space allows
	if conn.degraded && len(conn.buffer) > 0 {
		conn.bufferTelemetry(item)
		return
	}

	// Try publishing to Redis
	var err error
	if item.IsFrame {
		err = conn.ingester.PublishFrame(conn.SessionID, item.ID, item.Timestamp, item.ClientTS, conn.CorrelationID, item.Payload)
	} else {
		err = conn.ingester.PublishEvent(conn.SessionID, item.ID, item.Type, item.Timestamp, item.ClientTS, conn.CorrelationID)
	}

	if err != nil {
		log.Warn().
			Str("sessionId", conn.SessionID).
			Err(err).
			Msg("Redis unavailable during telemetry publish; starting buffering")

		conn.degraded = true
		conn.presence.SetPresence(conn.SessionID, "degraded")
		conn.bufferTelemetry(item)
		return
	}

	// Success: flush buffer if any
	if conn.degraded {
		conn.flushBuffer()
	}
}

func (conn *Connection) bufferTelemetry(item BufferedTelemetry) {
	if len(conn.buffer) >= 5 {
		// Buffer is full: drop telemetry item
		log.Warn().
			Str("sessionId", conn.SessionID).
			Bool("isFrame", item.IsFrame).
			Msg("Telemetry buffer full; dropping frame/event")
		return
	}

	conn.buffer = append(conn.buffer, item)
	log.Debug().
		Str("sessionId", conn.SessionID).
		Int("bufferSize", len(conn.buffer)).
		Msg("Buffered telemetry item locally")
}

func (conn *Connection) flushBuffer() {
	log.Info().Str("sessionId", conn.SessionID).Msg("Redis recovered; flushing buffered telemetry items")

	failedIdx := -1
	for i, item := range conn.buffer {
		var err error
		if item.IsFrame {
			err = conn.ingester.PublishFrame(conn.SessionID, item.ID, item.Timestamp, item.ClientTS, conn.CorrelationID, item.Payload)
		} else {
			err = conn.ingester.PublishEvent(conn.SessionID, item.ID, item.Type, item.Timestamp, item.ClientTS, conn.CorrelationID)
		}

		if err != nil {
			log.Warn().Err(err).Str("sessionId", conn.SessionID).Msg("Failed to flush telemetry item; re-buffering")
			failedIdx = i
			break
		}
	}

	if failedIdx == -1 {
		// Successfully flushed all items!
		conn.buffer = nil
		conn.degraded = false
		conn.presence.SetPresence(conn.SessionID, "connected")
		log.Info().Str("sessionId", conn.SessionID).Msg("Telemetry buffer flushed successfully")
	} else {
		// Slice out successfully sent items, keep the rest
		conn.buffer = conn.buffer[failedIdx:]
	}
}
