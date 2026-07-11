package authz

import (
	"os"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/stretchr/testify/assert"
)

func TestVerifyWSToken_Success(t *testing.T) {
	secret := "test_ws_secret_key"
	os.Setenv("JWT_WS_SECRET", secret)
	defer os.Unsetenv("JWT_WS_SECRET")

	claims := Claims{
		SessionID: "sess_123",
		UserID:    "user_456",
		ExamID:    "exam_789",
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenStr, err := token.SignedString([]byte(secret))
	assert.NoError(t, err)

	verifiedClaims, err := VerifyWSToken(tokenStr)
	assert.NoError(t, err)
	assert.Equal(t, "sess_123", verifiedClaims.SessionID)
	assert.Equal(t, "user_456", verifiedClaims.UserID)
	assert.Equal(t, "exam_789", verifiedClaims.ExamID)
}

func TestVerifyWSToken_Expired(t *testing.T) {
	secret := "test_ws_secret_key"
	os.Setenv("JWT_WS_SECRET", secret)
	defer os.Unsetenv("JWT_WS_SECRET")

	claims := Claims{
		SessionID: "sess_123",
		UserID:    "user_456",
		ExamID:    "exam_789",
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(-time.Hour)),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenStr, err := token.SignedString([]byte(secret))
	assert.NoError(t, err)

	_, err = VerifyWSToken(tokenStr)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "token has invalid claims") // In newer jwt v5, expired returns invalid claims error wrap
}

func TestVerifyWSToken_MissingSessionID(t *testing.T) {
	secret := "test_ws_secret_key"
	os.Setenv("JWT_WS_SECRET", secret)
	defer os.Unsetenv("JWT_WS_SECRET")

	claims := Claims{
		UserID: "user_456",
		ExamID: "exam_789",
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenStr, err := token.SignedString([]byte(secret))
	assert.NoError(t, err)

	_, err = VerifyWSToken(tokenStr)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "sessionId claim is missing")
}
