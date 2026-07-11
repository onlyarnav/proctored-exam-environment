package authz

import (
	"errors"
	"fmt"
	"os"

	"github.com/golang-jwt/jwt/v5"
)

// Claims represents the claims present in a proctoring WebSocket session token
type Claims struct {
	SessionID string `json:"sessionId"`
	UserID    string `json:"userId"`
	ExamID    string `json:"examId"`
	jwt.RegisteredClaims
}

// VerifyWSToken parses and validates a WebSocket session token, returning the verified claims
func VerifyWSToken(tokenStr string) (*Claims, error) {
	secret := os.Getenv("JWT_WS_SECRET")
	if secret == "" {
		secret = "dev_ws_secret_do_not_use_in_prod_1234567890"
	}

	token, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return []byte(secret), nil
	})

	if err != nil {
		return nil, err
	}

	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, errors.New("invalid token")
	}

	if claims.SessionID == "" {
		return nil, errors.New("sessionId claim is missing")
	}

	return claims, nil
}
