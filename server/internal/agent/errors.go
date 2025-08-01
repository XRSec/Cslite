package agent

import "errors"

var (
	ErrInvalidAPIKey        = errors.New("invalid API key")
	ErrRegistrationDisabled = errors.New("agent registration is disabled")
	ErrAgentNotFound        = errors.New("agent not found")
	ErrDeviceOffline        = errors.New("device is offline")
	ErrExecutionNotFound    = errors.New("execution not found")
)