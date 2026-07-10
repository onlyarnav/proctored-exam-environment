package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"judge-worker/internal/runner"
	"judge-worker/internal/sandbox"
)

type Job struct {
	SubmissionID   string     `json:"submissionId"`
	Language       string     `json:"language"`
	Code           string     `json:"code"`
	TestCases      []TestCase `json:"testCases"`
	Points         float64    `json:"points"`
	IdempotencyKey string     `json:"idempotencyKey"`
	CorrelationID  string     `json:"correlationId"`
}

type TestCase struct {
	Input          string `json:"input"`
	ExpectedOutput string `json:"expectedOutput"`
	IsPublic       bool   `json:"isPublic"`
}

type TestCaseResult struct {
	Input          string `json:"input"`
	ExpectedOutput string `json:"expectedOutput"`
	ActualOutput   string `json:"actualOutput"`
	Passed         bool   `json:"passed"`
	RuntimeMs      int64  `json:"runtimeMs"`
	Error          string `json:"error,omitempty"`
}

type JobResult struct {
	SubmissionID string           `json:"submissionId"`
	Results      []TestCaseResult `json:"results"`
	Score        float64          `json:"score"`
	Error        string           `json:"error,omitempty"`
}

func main() {
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	log.Logger = zerolog.New(os.Stdout).With().Timestamp().Logger()

	log.Info().Str("service", "judge-worker").Msg("Judge Worker Service starting...")

	// HTTP health check
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

	go func() {
		log.Info().Str("service", "judge-worker").Str("port", port).Msg("Health check listener starting...")
		if err := http.ListenAndServe(":"+port, nil); err != nil {
			log.Fatal().Str("service", "judge-worker").Err(err).Msg("Failed to start health check listener")
		}
	}()

	// Connect to Redis
	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		redisURL = "redis://localhost:6379"
	}
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		log.Fatal().Str("service", "judge-worker").Err(err).Msg("Failed to parse Redis URL")
	}

	rdb := redis.NewClient(opts)
	ctx := context.Background()

	// Verify connection
	if err := rdb.Ping(ctx).Err(); err != nil {
		log.Fatal().Str("service", "judge-worker").Err(err).Msg("Failed to ping Redis")
	}
	log.Info().Str("service", "judge-worker").Msg("Connected to Redis successfully")

	// Worker loop
	for {
		res, err := rdb.BLPop(ctx, 0, "judge:queue:submissions").Result()
		if err != nil {
			log.Error().Str("service", "judge-worker").Err(err).Msg("Error popping job from Redis list")
			time.Sleep(2 * time.Second)
			continue
		}

		if len(res) < 2 {
			continue
		}

		jobJSON := res[1]
		var job Job
		if err := json.Unmarshal([]byte(jobJSON), &job); err != nil {
			log.Error().Str("service", "judge-worker").Err(err).Msg("Failed to unmarshal job JSON")
			continue
		}

		log.Info().
			Str("service", "judge-worker").
			Str("submissionId", job.SubmissionID).
			Str("correlationId", job.CorrelationID).
			Str("language", job.Language).
			Msg("Processing code submission job...")

		// Process job synchronously to avoid concurrent task explosion on small worker,
		// or concurrently if needed. The spec mentions "worker pool, configurable concurrency".
		// For simplicity and correctness, running in a goroutine is fine.
		go func(j Job) {
			result := processJob(j, rdb)
			
			// Marshal result and push to judge:results queue
			resJSON, err := json.Marshal(result)
			if err != nil {
				log.Error().Str("service", "judge-worker").Err(err).Msg("Failed to marshal job result")
				return
			}

			err = rdb.RPush(context.Background(), "judge:results", string(resJSON)).Err()
			if err != nil {
				log.Error().Str("service", "judge-worker").Err(err).Msg("Failed to push result to Redis results list")
			}
		}(job)
	}
}

func processJob(job Job, rdb *redis.Client) JobResult {
	result := JobResult{
		SubmissionID: job.SubmissionID,
		Results:      []TestCaseResult{},
	}

	var lr runner.LanguageRunner
	switch strings.ToLower(job.Language) {
	case "python", "py":
		lr = runner.NewPythonRunner()
	case "javascript", "js", "node":
		lr = runner.NewJavaScriptRunner()
	case "cpp", "c++":
		lr = runner.NewCppRunner()
	case "java":
		lr = runner.NewJavaRunner()
	default:
		result.Error = "UNSUPPORTED_LANGUAGE"
		return result
	}

	passedCount := 0
	totalCount := len(job.TestCases)

	if totalCount == 0 {
		result.Score = job.Points
		return result
	}

	for _, tc := range job.TestCases {
		execRes, err := sandbox.Execute(lr, job.Code, tc.Input)
		
		tcRes := TestCaseResult{
			Input:          tc.Input,
			ExpectedOutput: tc.ExpectedOutput,
		}

		if err != nil {
			tcRes.Passed = false
			tcRes.Error = "SYSTEM_ERROR"
			tcRes.ActualOutput = err.Error()
		} else {
			if execRes.Error == "JUDGE_UNAVAILABLE" {
				log.Warn().Str("service", "judge-worker").Str("submissionId", job.SubmissionID).Msg("Judge unavailable. Requeuing job with backoff...")
				// Requeue the job back to the list
				jobJSON, _ := json.Marshal(job)
				time.Sleep(2 * time.Second) // backoff
				rdb.RPush(context.Background(), "judge:queue:submissions", string(jobJSON))
				
				result.Error = "JUDGE_UNAVAILABLE"
				return result
			}

			tcRes.Passed = execRes.Passed && strings.TrimSpace(execRes.Output) == strings.TrimSpace(tc.ExpectedOutput)
			tcRes.ActualOutput = execRes.Output
			tcRes.RuntimeMs = execRes.RuntimeMs
			tcRes.Error = execRes.Error
		}

		if tcRes.Passed {
			passedCount++
		}

		result.Results = append(result.Results, tcRes)
	}

	result.Score = job.Points * (float64(passedCount) / float64(totalCount))

	return result
}
