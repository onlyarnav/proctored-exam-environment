package middleware

import (
	"encoding/json"
	"io"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/stretchr/testify/assert"
)

func TestRecoverMiddleware(t *testing.T) {
	app := fiber.New()
	
	// Register correlation and recover middleware
	app.Use(Correlation())
	app.Use(Recover())

	// Endpoint that intentionally panics
	app.Get("/panic", func(c *fiber.Ctx) error {
		panic("simulated server panic")
	})

	req := httptest.NewRequest("GET", "/panic", nil)
	resp, err := app.Test(req)
	
	// Assertions
	assert.NoError(t, err)
	assert.Equal(t, fiber.StatusInternalServerError, resp.StatusCode)

	body, err := io.ReadAll(resp.Body)
	assert.NoError(t, err)

	var res map[string]map[string]interface{}
	err = json.Unmarshal(body, &res)
	assert.NoError(t, err)

	errDetail, ok := res["error"]
	assert.True(t, ok, "response should contain an 'error' block")
	assert.Equal(t, "INTERNAL_SERVER_ERROR", errDetail["code"])
	assert.Equal(t, "A critical system error occurred.", errDetail["message"])
	assert.NotEmpty(t, errDetail["correlationId"])
}
