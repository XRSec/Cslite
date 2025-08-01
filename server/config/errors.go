package config

import "errors"

var (
	ErrMissingDBDsn     = errors.New("missing database DSN")
	ErrMissingSecretKey = errors.New("missing secret key")
	ErrMissingJWTSecret = errors.New("missing JWT secret")
)