package main

import (
	"os"

	"proctor-gateway/internal/health"
	"proctor-gateway/internal/ingest"
	"proctor-gateway/internal/middleware"
	"proctor-gateway/internal/registry"
	"proctor-gateway/internal/shutdown"
	"proctor-gateway/internal/ws"

	"github.com/gofiber/fiber/v2"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

func main() {
	// Configure zerolog to log structured JSON to stdout
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	log.Logger = zerolog.New(os.Stdout).With().Timestamp().Logger()

	// 1. Initialize Redis Client
	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		redisURL = "redis://localhost:6379"
	}
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		log.Fatal().Err(err).Str("url", redisURL).Msg("Failed to parse Redis URL")
	}
	rdb := redis.NewClient(opt)

	// 2. Initialize Core Components
	presence := registry.NewPresenceRegistry(rdb)
	ingester := ingest.NewIngester(rdb)
	hub := ws.NewHub(rdb, presence, ingester)

	// 3. Initialize Fiber App
	app := fiber.New(fiber.Config{
		DisableStartupMessage: true,
	})

	// 4. Register global middleware
	app.Use(middleware.Correlation())
	app.Use(middleware.Recover())

	// 5. Expose Health Endpoint
	app.Get("/health", health.Handler)

	// 6. Expose Internal Presence Registry Endpoint for admin queries
	app.Get("/internal/presence", func(c *fiber.Ctx) error {
		all, err := presence.GetAllPresence()
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
				"error": err.Error(),
			})
		}
		return c.JSON(all)
	})

	app.Get("/internal/presence/:sessionId", func(c *fiber.Ctx) error {
		sessionID := c.Params("sessionId")
		info, err := presence.GetPresence(sessionID)
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
				"error": err.Error(),
			})
		}
		if info == nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
				"error": "presence not found",
			})
		}
		return c.JSON(info)
	})

	// 7. WebSocket upgrading endpoints
	app.Use("/ws", ws.ServeWebSocket(hub))
	app.Get("/ws", ws.Handler(hub, ingester, presence))

	// 8. Start Graceful Shutdown listener
	shutdown.ListenForShutdown(app, hub)

	// 9. Start Server Listener
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	log.Info().
		Str("service", "proctor-gateway").
		Str("port", port).
		Msg("Proctor Gateway Server starting...")

	if err := app.Listen(":" + port); err != nil {
		log.Fatal().
			Str("service", "proctor-gateway").
			Err(err).
			Msg("Failed to start Proctor Gateway Server")
	}
}
