package command

import "errors"

var (
	ErrInvalidCommandStatus = errors.New("invalid command status for this operation")
	ErrInvalidAction        = errors.New("invalid action")
	ErrInvalidCronExpression = errors.New("invalid cron expression")
)