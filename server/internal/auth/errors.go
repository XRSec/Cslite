package auth

import "errors"

var (
	ErrInvalidCredentials = errors.New("invalid username or password")
	ErrInvalidSession     = errors.New("invalid or expired session")
	ErrInvalidAPIKey      = errors.New("invalid API key")
	ErrUserExists         = errors.New("user already exists")
	ErrPermissionDenied   = errors.New("permission denied")
)