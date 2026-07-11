package ws

import (
	"os"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
	"proctor-gateway/internal/ingest"
	"proctor-gateway/internal/registry"
)

// Hub maintains the set of active client connections
type Hub struct {
	connections  map[string]*Connection // sessionId -> Connection
	mu           sync.RWMutex
	presence     *registry.PresenceRegistry
	ingester     *ingest.Ingester
	rdb          redis.Cmdable
	graceTimers  map[string]*time.Timer
	graceWindow  time.Duration
	graceMutex   sync.Mutex
	podID        string
}

// NewHub creates a new WebSocket Hub
func NewHub(rdb redis.Cmdable, presence *registry.PresenceRegistry, ingester *ingest.Ingester) *Hub {
	podID := os.Getenv("POD_IDENTITY")
	if podID == "" {
		podID = "pod-default"
	}
	return &Hub{
		connections: make(map[string]*Connection),
		presence:    presence,
		ingester:    ingester,
		rdb:         rdb,
		graceTimers: make(map[string]*time.Timer),
		graceWindow: 30 * time.Second,
		podID:       podID,
	}
}

// Register adds a connection to the hub, cancelling any pending grace period for the session
func (h *Hub) Register(conn *Connection) {
	h.mu.Lock()
	defer h.mu.Unlock()

	// Cancel any active grace timer for this session
	h.graceMutex.Lock()
	if timer, ok := h.graceTimers[conn.SessionID]; ok {
		timer.Stop()
		delete(h.graceTimers, conn.SessionID)
		log.Info().Str("sessionId", conn.SessionID).Msg("Cancelled reconnect grace period timer (client reconnected)")
	}
	h.graceMutex.Unlock()

	// If there's an existing connection, close it first (safety cleanup)
	if oldConn, ok := h.connections[conn.SessionID]; ok {
		if oldConn != conn {
			oldConn.Close()
		}
	}

	h.connections[conn.SessionID] = conn
	h.presence.SetPresence(conn.SessionID, "connected")
	log.Info().Str("sessionId", conn.SessionID).Str("connId", conn.ID).Msg("Client registered in hub")
}

// Unregister handles connection termination and starts the reconnect grace period
func (h *Hub) Unregister(conn *Connection, clean bool) {
	h.mu.Lock()
	defer h.mu.Unlock()

	// Verify this is the active connection for this session
	active, ok := h.connections[conn.SessionID]
	if !ok || active != conn {
		return
	}

	if clean {
		// Clean disconnect (e.g. forced close, logout, or graceful shutdown)
		delete(h.connections, conn.SessionID)
		h.presence.RemovePresence(conn.SessionID)
		log.Info().Str("sessionId", conn.SessionID).Str("connId", conn.ID).Msg("Client unregistered cleanly from hub")
		return
	}

	// Unexpected disconnect: start grace period timer
	h.presence.SetPresence(conn.SessionID, "disconnected")
	log.Info().Str("sessionId", conn.SessionID).Str("connId", conn.ID).Msg("Client disconnected unexpectedly; starting 30s grace period")

	h.graceMutex.Lock()
	// Stop existing timer if any
	if existing, ok := h.graceTimers[conn.SessionID]; ok {
		existing.Stop()
	}

	h.graceTimers[conn.SessionID] = time.AfterFunc(h.graceWindow, func() {
		h.handleGraceExpiry(conn.SessionID, conn.ID, conn.CorrelationID)
	})
	h.graceMutex.Unlock()
}

func (h *Hub) handleGraceExpiry(sessionID string, connID string, correlationID string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	h.graceMutex.Lock()
	delete(h.graceTimers, sessionID)
	h.graceMutex.Unlock()

	// Verify the session hasn't reconnected in the meantime
	conn, ok := h.connections[sessionID]
	if !ok || conn.ID != connID {
		return
	}

	// Grace period expired! Remove presence and delete connection
	delete(h.connections, sessionID)
	h.presence.RemovePresence(sessionID)

	log.Warn().Str("sessionId", sessionID).Str("connId", connID).Msg("Reconnect grace period expired; connection lost")

	// Emit CONNECTION_LOST flag/event downstream via Redis Stream
	if h.ingester != nil {
		eventID := uuid.New().String()
		now := time.Now().UnixMilli()
		err := h.ingester.PublishEvent(sessionID, eventID, "CONNECTION_LOST", now, now, correlationID)
		if err != nil {
			log.Error().Err(err).Str("sessionId", sessionID).Msg("Failed to publish CONNECTION_LOST event")
		}
	}
}

// GetConnection returns the active connection for a session ID, if any
func (h *Hub) GetConnection(sessionID string) *Connection {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.connections[sessionID]
}

// IsSessionConnected checks if a session is currently actively connected (not in grace period)
func (h *Hub) IsSessionConnected(sessionID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	_, ok := h.connections[sessionID]
	if !ok {
		return false
	}
	h.graceMutex.Lock()
	_, inGrace := h.graceTimers[sessionID]
	h.graceMutex.Unlock()
	return !inGrace
}

// CloseAll closes all active connections (used during shutdown)
func (h *Hub) CloseAll() {
	h.mu.Lock()
	defer h.mu.Unlock()

	h.graceMutex.Lock()
	for _, timer := range h.graceTimers {
		timer.Stop()
	}
	h.graceTimers = make(map[string]*time.Timer)
	h.graceMutex.Unlock()

	for sessionID, conn := range h.connections {
		conn.Close()
		delete(h.connections, sessionID)
		h.presence.RemovePresence(sessionID)
	}
}
