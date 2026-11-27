/**
 * Cslite Frozen API Contract v1
 * Zero runtime dependencies; shared across server, worker, scf, and web UI.
 */

export const ErrorCode = {
  OK: 20000,
  INVALID_CREDENTIALS: 40001,
  FORBIDDEN: 40002,
  UNAUTHORIZED: 40003,
  VALIDATION_ERROR: 40004,
  NOT_FOUND: 40005,
  CONFLICT: 40006,
  USER_EXISTS: 40009,
  DEVICE_NOT_FOUND: 40010,
  DEVICE_OFFLINE: 40011,
  REGISTRATION_DISABLED: 40013,
  EXECUTION_NOT_FOUND: 40020,
  INTERNAL_ERROR: 50001,
  INVALID_CRON: 60002,
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ApiEnvelope<T = unknown> {
  code: number;
  message: string;
  data: T | null;
}

// ============================================================================
// Auth & Users
// ============================================================================

export const UserRole = {
  USER: 0,
  ADMIN: 1,
} as const;

export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export interface UserDTO {
  id: number;
  username: string;
  email: string;
  role: UserRole;
  created_at?: string;
  updated_at?: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  user: UserDTO;
  session_token?: string;
}

export interface ChangePasswordRequest {
  old_password: string;
  new_password: string;
}

export interface CreateUserRequest {
  username: string;
  password: string;
  email?: string;
  role?: UserRole;
}

export interface UserListResponse {
  total: number;
  page: number;
  per_page: number;
  users: UserDTO[];
}

export interface ApiKeyDTO {
  id: string;
  name: string;
  key_prefix?: string;
  user_id?: number;
  created_at: string;
  last_used?: string | null;
}

export interface CreateApiKeyRequest {
  name?: string;
}

export interface CreateApiKeyResponse {
  id: string;
  name: string;
  api_key: string;
  key_prefix?: string;
  created_at: string;
}

// ============================================================================
// Devices & Groups
// ============================================================================

export type PlatformType = 'linux' | 'openwrt' | 'macos' | 'windows' | 'android' | 'unix' | 'other' | (string & {});

export type DeviceStatus = 'online' | 'offline' | 'busy';

export interface DeviceMetrics {
  cpu_usage: number;
  memory_used: number;
  memory_total?: number;
  memory_percent?: number;
  disk_usage: number;
  disk_total?: number;
  network_in: number;
  network_out: number;
  load_avg?: string;
  uptime?: number;
}

export interface DeviceDTO {
  id: string;
  name: string;
  platform: PlatformType;
  arch?: string;
  os_version?: string;
  hostname?: string;
  status: DeviceStatus;
  owner_id: number;
  group_id?: string | null;
  ip_address?: string;
  agent_id?: string;
  agent_version?: string;
  metrics?: DeviceMetrics | null;
  last_seen: string;
  created_at?: string;
  updated_at?: string;
}

export interface CreateDeviceRequest {
  name: string;
  platform: PlatformType;
  group_id?: string;
}

export interface CreateDeviceResponse {
  id: string;
  install_command: string;
  install_commands?: Record<string, string>;
  expires_at: string;
}

export interface UpdateDeviceRequest {
  name?: string;
  platform?: PlatformType;
  group_id?: string | null;
}

export interface DeviceListResponse {
  total: number;
  page: number;
  per_page: number;
  devices: DeviceDTO[];
}

export interface DeviceStatusResponse {
  id: string;
  status: DeviceStatus;
  last_updated: string;
  metrics?: DeviceMetrics | null;
}

export interface BatchDeleteDevicesRequest {
  ids: string[];
}

export interface GroupDTO {
  id: string;
  name: string;
  description: string;
  created_by?: number;
  device_count: number;
  device_ids?: string[];
  created_at: string;
  updated_at?: string;
}

export interface CreateGroupRequest {
  name: string;
  description?: string;
}

export interface UpdateGroupRequest {
  name?: string;
  description?: string;
}

export interface GroupDevicesRequest {
  device_ids: string[];
}

// ============================================================================
// Commands & Executions
// ============================================================================

export type CommandType = 'immediate' | 'once' | 'cron';

export type CommandStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'cancelled';

export type TargetType = 'devices' | 'groups';

export type CommandAction = 'pause' | 'resume' | 'cancel';

export type ExecutionStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'cancelled';

export interface RetryPolicy {
  enabled: boolean;
  max_attempts: number;
}

export interface CreateCommandRequest {
  name: string;
  type: CommandType;
  schedule?: string;
  content: string;
  target_type: TargetType;
  target_ids: string[];
  timeout?: number;
  shell?: string;
  retry_policy?: RetryPolicy;
  env_vars?: Record<string, string>;
}

export interface UpdateCommandStatusRequest {
  action: CommandAction;
}

export interface CommandDTO {
  id: string;
  name: string;
  type: CommandType;
  schedule?: string;
  content?: string;
  target_type?: TargetType;
  target_ids?: string[];
  timeout?: number;
  shell?: string;
  status: CommandStatus;
  next_run?: string | null;
  created_by?: number;
  created_at: string;
  updated_at?: string;
}

export interface ExecutionDeviceResultDTO {
  id?: string;
  result_id?: string;
  execution_id?: string;
  device_id: string;
  device_name?: string;
  status: ExecutionStatus;
  exit_code: number;
  output: string;
  log_url: string;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface ExecutionDTO {
  id: string;
  command_id?: string;
  status: ExecutionStatus;
  scheduled_for?: string | null;
  started_at: string;
  completed_at?: string | null;
  device_results?: ExecutionDeviceResultDTO[];
}

export interface CommandDetailDTO extends CommandDTO {
  schedule: string;
  content: string;
  target_type: TargetType;
  target_ids: string[];
  timeout: number;
  retry_policy?: RetryPolicy | null;
  env_vars?: Record<string, string> | null;
  execution_history: ExecutionDTO[];
}

export interface CommandResultsResponse {
  command_id: string;
  executions: ExecutionDTO[];
}

export interface CommandListResponse {
  total: number;
  page?: number;
  per_page?: number;
  commands: CommandDTO[];
}

export interface CommandTask {
  result_id: string;
  command_id: string;
  execution_id: string;
  name?: string;
  type: CommandType;
  schedule?: string;
  content: string;
  timeout: number;
  shell?: string;
  env_vars?: Record<string, string>;
}

// ============================================================================
// Agent Protocol (/api/agent/*)
// ============================================================================

export interface AgentRegisterRequest {
  name: string;
  platform: PlatformType;
  arch?: string;
  os_version?: string;
  hostname?: string;
  version: string;
  device_id?: string;
  api_key?: string;
}

export interface AgentRegisterResponse {
  agent_id: string;
  device_id: string;
  heartbeat_interval: number;
  poll_interval: number;
}

export interface AgentHeartbeatRequest {
  agent_id: string;
  device_id?: string;
  api_key?: string;
  metrics?: DeviceMetrics;
  ip_address?: string;
  version?: string;
  os_version?: string;
  hostname?: string;
  timestamp?: string;
}

export interface AgentHeartbeatResponse {
  status: 'ok';
  next_heartbeat: number;
  poll_interval: number;
}

export interface AgentPollCommandsRequest {
  agent_id: string;
  api_key?: string;
  limit?: number;
  metrics?: DeviceMetrics;
  ip_address?: string;
  version?: string;
  os_version?: string;
  hostname?: string;
  timestamp?: string;
}

export interface AgentPollCommandsResponse {
  commands: CommandTask[];
  poll_interval?: number;
  next_heartbeat?: number;
}

export interface AgentResultRequest {
  result_id?: string;
  execution_id: string;
  device_id: string;
  api_key?: string;
  status: 'completed' | 'failed' | 'timeout' | 'cancelled';
  exit_code?: number;
  output?: string;
  log?: string;
  completed_at?: string;
}

export interface AgentResultResponse {
  status: 'received';
  logged: boolean;
}

// ============================================================================
// Logs & System
// ============================================================================

export interface CommandLogDTO {
  result_id?: string;
  execution_id: string;
  command_id?: string;
  command_name?: string;
  device_id: string;
  device_name?: string;
  status: ExecutionStatus;
  exit_code: number;
  output_preview: string;
  log_url: string;
  started_at: string;
  completed_at?: string | null;
}

export interface DeviceLogDTO {
  id: string;
  device_id: string;
  type: string;
  timestamp: string;
  message: string;
  metadata?: Record<string, unknown> | null;
}

export interface AuditLogDTO {
  id: string;
  user_id: number;
  username?: string;
  action: string;
  target_id: string;
  ip: string;
  detail?: string;
  timestamp: string;
}

export interface LogListResponse<T> {
  total: number;
  page?: number;
  per_page?: number;
  logs: T[];
}

export interface SystemInfoDTO {
  version: string;
  runtime: 'node' | 'cloudflare-worker' | 'scf' | (string & {});
  db_dialect: 'sqlite' | 'mysql';
  allow_registration: boolean;
  heartbeat_interval: number;
  poll_interval: number;
  server_time: string;
}
