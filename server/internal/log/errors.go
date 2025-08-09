// log 包提供了日志管理相关的服务
package log

import "errors"

// 日志相关的错误定义
var (
	ErrLogNotFound = errors.New("log file not found") // 日志文件未找到
)
