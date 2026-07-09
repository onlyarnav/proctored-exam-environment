package middleware

import (
	"runtime/debug"

	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog/log"
)

// Recover is a middleware that recovers from panics in Fiber handlers
func Recover() fiber.Handler {
	return func(c *fiber.Ctx) error {
		defer func() {
			if r := recover(); r != nil {
				corrID := c.Locals("correlationId")
				if corrID == nil {
					corrID = "unknown"
				}
				
				// Structured JSON Log for error alerting
				log.Error().
					Interface("panic", r).
					Str("service", "proctor-gateway").
					Interface("correlationId", corrID).
					Str("path", c.Path()).
					Str("method", c.Method()).
					Str("stack", string(debug.Stack())).
					Msg("Panic recovered in Fiber gateway")

				c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
					"error": fiber.Map{
						"code":          "INTERNAL_SERVER_ERROR",
						"message":       "A critical system error occurred.",
						"correlationId": corrID,
					},
				})
			}
		}()
		return c.Next()
	}
}
