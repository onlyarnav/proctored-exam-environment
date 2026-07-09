package main

import (
	"os"

	"proctor-gateway/internal/health"
	"proctor-gateway/internal/middleware"
	"proctor-gateway/internal/ws"

	"github.com/gofiber/fiber/v2"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

func main() {
	// Configure zerolog to log structured JSON to stdout
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	log.Logger = zerolog.New(os.Stdout).With().Timestamp().Logger()

	// Initialize Fiber App
	app := fiber.New(fiber.Config{
		DisableStartupMessage: true,
	})

	// Setup WebSocket Hub
	hub := ws.NewHub()
	go hub.Run()

	// Register global middleware
	app.Use(middleware.Correlation())
	app.Use(middleware.Recover())

	// Health endpoint
	app.Get("/health", health.Handler)

	// WebSocket upgrading endpoints
	app.Use("/ws", ws.ServeWebSocket(hub))
	app.Get("/ws", ws.Handler(hub))

	// Get port from env or default to 8080
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
