// Package protocol defines the wire DTOs matching Cslite Frozen API Contract v1.
package protocol

// Error codes from shared/types.ts.
const (
	CodeOK                   = 20000
	CodeInvalidCredentials   = 40001
	CodeForbidden            = 40002
	CodeUnauthorized         = 40003
	CodeValidationError      = 40004
	CodeNotFound             = 40005
	CodeConflict             = 40006
	CodeDeviceNotFound       = 40010
	CodeDeviceOffline        = 40011
	CodeRegistrationDisabled = 40013
	CodeExecutionNotFound    = 40020
	CodeInternalError        = 50001
)

// Execution statuses reported by agents.
const (
	StatusCompleted = "completed"
	StatusFailed    = "failed"
	StatusTimeout   = "timeout"
	StatusCancelled = "cancelled"
)

// Envelope wraps every API response.
type Envelope[T any] struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    T      `json:"data"`
}

// DeviceMetrics represents host telemetry sent in heartbeats.
type DeviceMetrics struct {
	CPUUsage      float64 `json:"cpu_usage"`
	MemoryUsed    int     `json:"memory_used"`
	MemoryTotal   int     `json:"memory_total,omitempty"`
	MemoryPercent float64 `json:"memory_percent,omitempty"`
	DiskUsage     float64 `json:"disk_usage"`
	DiskTotal     int64   `json:"disk_total,omitempty"`
	NetworkIn     int     `json:"network_in"`
	NetworkOut    int     `json:"network_out"`
	LoadAvg       string  `json:"load_avg,omitempty"`
	Uptime        int64   `json:"uptime,omitempty"`
}

// RegisterRequest corresponds to AgentRegisterRequest.
type RegisterRequest struct {
	Name      string `json:"name"`
	Platform  string `json:"platform"`
	Arch      string `json:"arch,omitempty"`
	OSVersion string `json:"os_version,omitempty"`
	Hostname  string `json:"hostname,omitempty"`
	Version   string `json:"version"`
	DeviceID  string `json:"device_id,omitempty"`
	APIKey    string `json:"api_key,omitempty"`
}

// RegisterResponse corresponds to AgentRegisterResponse.
type RegisterResponse struct {
	AgentID           string `json:"agent_id"`
	DeviceID          string `json:"device_id"`
	HeartbeatInterval int    `json:"heartbeat_interval"`
	PollInterval      int    `json:"poll_interval"`
}

// HeartbeatRequest corresponds to AgentHeartbeatRequest.
type HeartbeatRequest struct {
	AgentID   string         `json:"agent_id"`
	DeviceID  string         `json:"device_id,omitempty"`
	APIKey    string         `json:"api_key,omitempty"`
	Metrics   *DeviceMetrics `json:"metrics,omitempty"`
	IPAddress string         `json:"ip_address,omitempty"`
	Version   string         `json:"version,omitempty"`
	OSVersion string         `json:"os_version,omitempty"`
	Hostname  string         `json:"hostname,omitempty"`
	Timestamp string         `json:"timestamp,omitempty"`
}

// HeartbeatResponse corresponds to AgentHeartbeatResponse.
type HeartbeatResponse struct {
	Status        string `json:"status"`
	NextHeartbeat int    `json:"next_heartbeat"`
	PollInterval  int    `json:"poll_interval"`
}

// PollCommandsRequest corresponds to AgentPollCommandsRequest.
type PollCommandsRequest struct {
	AgentID   string         `json:"agent_id"`
	APIKey    string         `json:"api_key,omitempty"`
	Limit     int            `json:"limit,omitempty"`
	Metrics   *DeviceMetrics `json:"metrics,omitempty"`
	IPAddress string         `json:"ip_address,omitempty"`
	Version   string         `json:"version,omitempty"`
	OSVersion string         `json:"os_version,omitempty"`
	Hostname  string         `json:"hostname,omitempty"`
	Timestamp string         `json:"timestamp,omitempty"`
}

// CommandTask corresponds to CommandTask.
type CommandTask struct {
	ResultID    string            `json:"result_id"`
	CommandID   string            `json:"command_id"`
	ExecutionID string            `json:"execution_id"`
	Name        string            `json:"name,omitempty"`
	Type        string            `json:"type"`
	Schedule    string            `json:"schedule,omitempty"`
	Content     string            `json:"content"`
	Timeout     int               `json:"timeout"`
	Shell       string            `json:"shell,omitempty"`
	EnvVars     map[string]string `json:"env_vars,omitempty"`
}

// PollCommandsResponse corresponds to AgentPollCommandsResponse.
type PollCommandsResponse struct {
	Commands      []CommandTask `json:"commands"`
	PollInterval  int           `json:"poll_interval,omitempty"`
	NextHeartbeat int           `json:"next_heartbeat,omitempty"`
}

// ResultRequest corresponds to AgentResultRequest.
type ResultRequest struct {
	ResultID    string `json:"result_id,omitempty"`
	ExecutionID string `json:"execution_id"`
	DeviceID    string `json:"device_id"`
	APIKey      string `json:"api_key,omitempty"`
	Status      string `json:"status"`
	ExitCode    int    `json:"exit_code"`
	Output      string `json:"output,omitempty"`
	Log         string `json:"log,omitempty"`
	CompletedAt string `json:"completed_at,omitempty"`
}

// ResultResponse corresponds to AgentResultResponse.
type ResultResponse struct {
	Status string `json:"status"`
	Logged bool   `json:"logged"`
}
