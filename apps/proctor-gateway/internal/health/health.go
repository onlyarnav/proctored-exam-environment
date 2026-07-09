package health

import "github.com/gofiber/fiber/v2"

// Handler returns status check for proctor gateway
func Handler(c *fiber.Ctx) error {
	return c.Status(fiber.StatusOK).JSON(fiber.Map{
		"status":  "healthy",
		"service": "proctor-gateway",
	})
}
