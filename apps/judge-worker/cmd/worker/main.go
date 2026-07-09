package main

import (
	"encoding/json"
	"net/http"
	"os"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

func main() {
	// Configure structured JSON logging
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	log.Logger = zerolog.New(os.Stdout).With().Timestamp().Logger()

	log.Info().
		Str("service", "judge-worker").
		Msg("Judge Worker Service starting...")

	// HTTP health check handler
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"status":  "healthy",
			"service": "judge-worker",
		})
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8081"
	}

	log.Info().
		Str("service", "judge-worker").
		Str("port", port).
		Msg("Health check listener starting...")

	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatal().
			Str("service", "judge-worker").
			Err(err).
			Msg("Failed to start health check listener")
	}
}
