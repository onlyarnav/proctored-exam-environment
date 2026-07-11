package protocol

import (
	"encoding/binary"
	"errors"
)

const (
	// MessageTypeFrame is the identifier for webcam frames (0x01)
	MessageTypeFrame byte = 0x01
	// MessageTypeEvent is the identifier for integrity events (0x02)
	MessageTypeEvent byte = 0x02
)

// IntegrityEvent represents the JSON payload structure of integrity events
type IntegrityEvent struct {
	EventType       string `json:"eventType"`
	ClientTimestamp int64  `json:"clientTimestamp"`
}

// ParseMessage decodes the binary message frame into type, client timestamp, and payload
func ParseMessage(data []byte) (byte, uint64, []byte, error) {
	if len(data) < 9 {
		return 0, 0, nil, errors.New("message too short, minimum 9 bytes required")
	}

	msgType := data[0]
	if msgType != MessageTypeFrame && msgType != MessageTypeEvent {
		return 0, 0, nil, errors.New("invalid message type")
	}

	clientTimestamp := binary.BigEndian.Uint64(data[1:9])
	payload := data[9:]

	return msgType, clientTimestamp, payload, nil
}
