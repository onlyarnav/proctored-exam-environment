package middleware

import (
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

// Correlation is a middleware that manages tracking correlation IDs
func Correlation() fiber.Handler {
	return func(c *fiber.Ctx) error {
		corrID := c.Get("x-correlation-id")
		if corrID == "" {
			// Generate a clean req_uuid format without dashes
			rawUUID := uuid.New().String()
			cleanUUID := strings.ReplaceAll(rawUUID, "-", "")
			corrID = "req_" + cleanUUID
		}
		c.Locals("correlationId", corrID)
		c.Set("x-correlation-id", corrID)
		return c.Next()
	}
}
