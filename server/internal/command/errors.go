// command 包提供了命令管理相关的服务
package command

import "errors"

// 命令相关的错误定义
var (
	ErrInvalidCommandStatus  = errors.New("invalid command status for this operation") // 命令状态无效，无法执行此操作
	ErrInvalidAction         = errors.New("invalid action")                            // 无效的操作
	ErrInvalidCronExpression = errors.New("invalid cron expression")                   // 无效的cron表达式
)
