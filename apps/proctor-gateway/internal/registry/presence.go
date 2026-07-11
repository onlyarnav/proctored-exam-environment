package registry

import (
	"context"
	"encoding/json"
	"os"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

// PresenceInfo represents the state of a candidate's proctoring connection
type PresenceInfo struct {
	SessionID      string    `json:"sessionId"`
	PodID          string    `json:"podId"`
	State          string    `json:"state"` // "connected" | "disconnected" | "degraded"
	DisconnectedAt time.Time `json:"disconnectedAt,omitempty"`
}

// PresenceRegistry manages session state locally and coordinates with Redis for a global cluster view
type PresenceRegistry struct {
	mu        sync.RWMutex
	local     map[string]*PresenceInfo
	rdb       redis.Cmdable
	podID     string
	redisKey  string
	ctx       context.Context
}

// NewPresenceRegistry creates a new PresenceRegistry
func NewPresenceRegistry(rdb redis.Cmdable) *PresenceRegistry {
	podID := os.Getenv("POD_IDENTITY")
	if podID == "" {
		podID = "pod-default"
	}
	return &PresenceRegistry{
		local:    make(map[string]*PresenceInfo),
		rdb:      rdb,
		podID:    podID,
		redisKey: "proctor:presence",
		ctx:      context.Background(),
	}
}

// SetPresence updates a session's presence state globally in Redis and locally in-memory
func (pr *PresenceRegistry) SetPresence(sessionID string, state string) {
	pr.mu.Lock()
	info := &PresenceInfo{
		SessionID: sessionID,
		PodID:     pr.podID,
		State:     state,
	}
	if state == "disconnected" {
		info.DisconnectedAt = time.Now()
	}
	pr.local[sessionID] = info
	pr.mu.Unlock()

	// Sync to Redis
	if pr.rdb != nil {
		data, err := json.Marshal(info)
		if err != nil {
			log.Error().Err(err).Msg("Failed to marshal presence info")
			return
		}
		err = pr.rdb.HSet(pr.ctx, pr.redisKey, sessionID, data).Err()
		if err != nil {
			log.Warn().Err(err).Str("sessionId", sessionID).Msg("Failed to sync presence to Redis")
		}
	}
}

// RemovePresence removes a session from presence tracking (e.g. grace period expired or explicit close)
func (pr *PresenceRegistry) RemovePresence(sessionID string) {
	pr.mu.Lock()
	delete(pr.local, sessionID)
	pr.mu.Unlock()

	// Sync to Redis
	if pr.rdb != nil {
		err := pr.rdb.HDel(pr.ctx, pr.redisKey, sessionID).Err()
		if err != nil {
			log.Warn().Err(err).Str("sessionId", sessionID).Msg("Failed to delete presence from Redis")
		}
	}
}

// GetPresence retrieves global presence details for a session from Redis
func (pr *PresenceRegistry) GetPresence(sessionID string) (*PresenceInfo, error) {
	if pr.rdb != nil {
		data, err := pr.rdb.HGet(pr.ctx, pr.redisKey, sessionID).Result()
		if err == redis.Nil {
			return nil, nil
		} else if err != nil {
			return nil, err
		}

		var info PresenceInfo
		if err := json.Unmarshal([]byte(data), &info); err != nil {
			return nil, err
		}
		return &info, nil
	}

	// Fallback to local
	pr.mu.RLock()
	defer pr.mu.RUnlock()
	if info, ok := pr.local[sessionID]; ok {
		return info, nil
	}
	return nil, nil
}

// GetAllPresence retrieves all tracked presences across the entire cluster
func (pr *PresenceRegistry) GetAllPresence() (map[string]*PresenceInfo, error) {
	result := make(map[string]*PresenceInfo)

	if pr.rdb != nil {
		data, err := pr.rdb.HGetAll(pr.ctx, pr.redisKey).Result()
		if err != nil {
			return nil, err
		}

		for k, v := range data {
			var info PresenceInfo
			if err := json.Unmarshal([]byte(v), &info); err != nil {
				log.Error().Err(err).Str("sessionId", k).Msg("Failed to unmarshal presence data from Redis")
				continue
			}
			result[k] = &info
		}
		return result, nil
	}

	// Fallback to local
	pr.mu.RLock()
	defer pr.mu.RUnlock()
	for k, v := range pr.local {
		result[k] = v
	}
	return result, nil
}
