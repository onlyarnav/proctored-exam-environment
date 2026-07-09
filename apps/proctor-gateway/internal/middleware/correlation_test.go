package middleware

import (
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/stretchr/testify/assert"
)

func TestCorrelationMiddleware_Generated(t *testing.T) {
	app := fiber.New()
	app.Use(Correlation())

	app.Get("/test", func(c *fiber.Ctx) error {
		corrID := c.Locals("correlationId")
		return c.SendString(corrID.(string))
	})

	req := httptest.NewRequest("GET", "/test", nil)
	resp, err := app.Test(req)
	assert.NoError(t, err)

	corrHeader := resp.Header.Get("x-correlation-id")
	assert.NotEmpty(t, corrHeader)
	assert.Contains(t, corrHeader, "req_")
}

func TestCorrelationMiddleware_Propagated(t *testing.T) {
	app := fiber.New()
	app.Use(Correlation())

	app.Get("/test", func(c *fiber.Ctx) error {
		corrID := c.Locals("correlationId")
		return c.SendString(corrID.(string))
	})

	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("x-correlation-id", "req_custom_id_123")
	resp, err := app.Test(req)
	assert.NoError(t, err)

	corrHeader := resp.Header.Get("x-correlation-id")
	assert.Equal(t, "req_custom_id_123", corrHeader)
}
