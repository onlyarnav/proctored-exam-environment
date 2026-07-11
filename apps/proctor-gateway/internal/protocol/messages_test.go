package protocol

import (
	"encoding/binary"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestParseMessage_Frame(t *testing.T) {
	payloadBytes := []byte("jpeg_bytes")
	data := make([]byte, 9+len(payloadBytes))
	data[0] = MessageTypeFrame
	binary.BigEndian.PutUint64(data[1:9], 1625900000000)
	copy(data[9:], payloadBytes)

	msgType, ts, payload, err := ParseMessage(data)
	assert.NoError(t, err)
	assert.Equal(t, MessageTypeFrame, msgType)
	assert.Equal(t, uint64(1625900000000), ts)
	assert.Equal(t, []byte("jpeg_bytes"), payload)
}

func TestParseMessage_Event(t *testing.T) {
	payloadBytes := []byte(`{"event"}`)
	data := make([]byte, 9+len(payloadBytes))
	data[0] = MessageTypeEvent
	binary.BigEndian.PutUint64(data[1:9], 1625900000000)
	copy(data[9:], payloadBytes) // Mock json string representation

	msgType, ts, payload, err := ParseMessage(data)
	assert.NoError(t, err)
	assert.Equal(t, MessageTypeEvent, msgType)
	assert.Equal(t, uint64(1625900000000), ts)
	assert.Equal(t, []byte(`{"event"}`), payload)
}

func TestParseMessage_Short(t *testing.T) {
	data := []byte{0x01, 0x00, 0x00}
	_, _, _, err := ParseMessage(data)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "message too short")
}

func TestParseMessage_InvalidType(t *testing.T) {
	data := make([]byte, 10)
	data[0] = 0x03 // invalid type
	_, _, _, err := ParseMessage(data)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "invalid message type")
}
