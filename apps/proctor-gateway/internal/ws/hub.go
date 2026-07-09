package ws

import (
	"sync"

	"github.com/rs/zerolog/log"
)

// Hub maintains the set of active client connections
type Hub struct {
	connections map[string]*Connection
	register    chan *Connection
	unregister  chan *Connection
	mu          sync.RWMutex
}

// NewHub creates a new WebSocket Hub
func NewHub() *Hub {
	return &Hub{
		connections: make(map[string]*Connection),
		register:    make(chan *Connection),
		unregister:  make(chan *Connection),
	}
}

// Run starts the event loop for registered connections
func (h *Hub) Run() {
	log.Info().Str("service", "proctor-gateway").Msg("WebSocket Hub event loop started")
	for {
		select {
		case conn := <-h.register:
			h.mu.Lock()
			h.connections[conn.ID] = conn
			h.mu.Unlock()
			log.Info().Str("connId", conn.ID).Msg("Client registered in hub")
		case conn := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.connections[conn.ID]; ok {
				delete(h.connections, conn.ID)
				close(conn.send)
			}
			h.mu.Unlock()
			log.Info().Str("connId", conn.ID).Msg("Client unregistered from hub")
		}
	}
}
