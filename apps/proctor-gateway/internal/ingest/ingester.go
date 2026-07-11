package ingest

import (
	"context"

	"github.com/redis/go-redis/v9"
)

// Ingester handles publishing telemetry data (frames and events) to Redis Streams
type Ingester struct {
	rdb redis.Cmdable
	ctx context.Context
}

// NewIngester creates a new Ingester instance
func NewIngester(rdb redis.Cmdable) *Ingester {
	return &Ingester{
		rdb: rdb,
		ctx: context.Background(),
	}
}

// PublishFrame sends a webcam frame metadata and data bytes to the proctor:frames stream
func (ing *Ingester) PublishFrame(sessionID string, frameID string, serverTS int64, clientTS int64, correlationID string, data []byte) error {
	return ing.rdb.XAdd(ing.ctx, &redis.XAddArgs{
		Stream: "proctor:frames",
		MaxLen: 5000,
		Approx: true,
		Values: map[string]interface{}{
			"sessionId":       sessionID,
			"frameId":         frameID,
			"serverTimestamp": serverTS,
			"clientTimestamp": clientTS,
			"correlationId":   correlationID,
			"data":            data,
		},
	}).Err()
}

// PublishEvent sends an integrity event details to the proctor:events stream
func (ing *Ingester) PublishEvent(sessionID string, eventID string, eventType string, serverTS int64, clientTS int64, correlationID string) error {
	return ing.rdb.XAdd(ing.ctx, &redis.XAddArgs{
		Stream: "proctor:events",
		MaxLen: 5000,
		Approx: true,
		Values: map[string]interface{}{
			"sessionId":       sessionID,
			"eventId":         eventID,
			"eventType":       eventType,
			"serverTimestamp": serverTS,
			"clientTimestamp": clientTS,
			"correlationId":   correlationID,
		},
	}).Err()
}
