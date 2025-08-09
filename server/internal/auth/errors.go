// auth 包提供了用户认证相关的服务
package auth

import "errors"

// 认证相关的错误定义
var (
	ErrInvalidCredentials = errors.New("invalid username or password") // 用户名或密码无效
	ErrInvalidSession     = errors.New("invalid or expired session")   // 会话无效或已过期
	ErrInvalidAPIKey      = errors.New("invalid API key")              // API密钥无效
	ErrUserExists         = errors.New("user already exists")          // 用户已存在
	ErrPermissionDenied   = errors.New("permission denied")            // 权限被拒绝
)
