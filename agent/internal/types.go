package internal

type RegisterRequest struct {
	Name     string `json:"name"`
	Platform string `json:"platform"`
	Version  string `json:"version"`
}

type HeartbeatRequest struct {
	AgentID   string            `json:"agent_id"`
	Metrics   *SystemMetrics    `json:"metrics"`
	Timestamp string            `json:"timestamp"`
}

type Command struct {
	CommandID   string            `json:"command_id"`
	ExecutionID string            `json:"execution_id"`
	Content     string            `json:"content"`
	Timeout     int               `json:"timeout"`
	EnvVars     map[string]string `json:"env_vars"`
}

type ExecutionResult struct {
	ExecutionID string `json:"execution_id"`
	DeviceID    string `json:"device_id"`
	Status      string `json:"status"`
	ExitCode    int    `json:"exit_code"`
	Output      string `json:"output"`
	Log         string `json:"log"`
	CompletedAt string `json:"completed_at"`
}

type SystemMetrics struct {
	CPUUsage    float64 `json:"cpu_usage"`
	MemoryUsed  int     `json:"memory_used"`
	DiskUsage   float64 `json:"disk_usage"`
	NetworkIn   int     `json:"network_in,omitempty"`
	NetworkOut  int     `json:"network_out,omitempty"`
}