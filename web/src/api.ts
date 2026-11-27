import {
  ErrorCode,
  type ApiEnvelope,
  type ApiKeyDTO,
  type AuditLogDTO,
  type BatchDeleteDevicesRequest,
  type ChangePasswordRequest,
  type CommandAction,
  type CommandDTO,
  type CommandDetailDTO,
  type CommandListResponse,
  type CommandLogDTO,
  type CommandResultsResponse,
  type CreateApiKeyRequest,
  type CreateApiKeyResponse,
  type CreateCommandRequest,
  type CreateDeviceRequest,
  type CreateDeviceResponse,
  type CreateGroupRequest,
  type CreateUserRequest,
  type DeviceDTO,
  type DeviceListResponse,
  type DeviceLogDTO,
  type DeviceStatusResponse,
  type GroupDTO,
  type GroupDevicesRequest,
  type LogListResponse,
  type LoginRequest,
  type LoginResponse,
  type SystemInfoDTO,
  type UpdateCommandStatusRequest,
  type UpdateDeviceRequest,
  type UpdateGroupRequest,
  type UserDTO,
  type UserListResponse,
} from '../../shared/types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: number;
  constructor(status: number, code: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

let onUnauth: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauth = fn;
}

function q(params?: Record<string, string | number | undefined | null>): string {
  if (!params) return '';
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

async function req<T>(path: string, method = 'GET', body?: unknown, skipAuth = false): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let bodyStr: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyStr = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: bodyStr, credentials: 'same-origin' });
  } catch (err) {
    throw new ApiError(0, ErrorCode.INTERNAL_ERROR, err instanceof Error ? err.message : 'Network error');
  }
  const raw = await res.text();
  let parsed: ApiEnvelope<T> | null = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw) as ApiEnvelope<T>;
    } catch {
      parsed = null;
    }
  }
  const code = parsed && typeof parsed.code === 'number' ? parsed.code : null;
  const msg = (parsed && typeof parsed.message === 'string' && parsed.message) || res.statusText || `HTTP ${res.status}`;

  if (res.status === 401 || code === ErrorCode.UNAUTHORIZED) {
    if (!skipAuth && onUnauth) onUnauth();
    throw new ApiError(res.status, code ?? ErrorCode.UNAUTHORIZED, msg);
  }
  if (!res.ok || (code !== null && code !== ErrorCode.OK)) {
    throw new ApiError(res.status, code ?? res.status, msg);
  }
  return (parsed && 'data' in parsed ? parsed.data : parsed) as T;
}

const get = <T>(p: string, params?: Record<string, string | number | undefined | null>, skipAuth = false) =>
  req<T>(`${p}${q(params)}`, 'GET', undefined, skipAuth);
const post = <T>(p: string, b?: unknown, skipAuth = false) => req<T>(p, 'POST', b, skipAuth);
const put = <T>(p: string, b?: unknown) => req<T>(p, 'PUT', b);
const del = <T>(p: string, b?: unknown) => req<T>(p, 'DELETE', b);
const enc = encodeURIComponent;

export const api = {
  login: (b: LoginRequest) => post<LoginResponse>('/api/auth/login', b, true),
  logout: () => post<void>('/api/auth/logout', {}),
  async getMe(skipAuth = false): Promise<UserDTO> {
    const d = await get<UserDTO | { user: UserDTO }>('/api/auth/me', undefined, skipAuth);
    return d && typeof d === 'object' && 'user' in d && d.user ? d.user : (d as UserDTO);
  },
  changePassword: (b: ChangePasswordRequest) => post<void>('/api/auth/password', b),
  async listApiKeys(): Promise<ApiKeyDTO[]> {
    const d = await get<ApiKeyDTO[] | { keys?: ApiKeyDTO[]; api_keys?: ApiKeyDTO[] }>('/api/auth/key');
    return Array.isArray(d) ? d : d?.keys ?? d?.api_keys ?? [];
  },
  createApiKey: (b: CreateApiKeyRequest = {}) => post<CreateApiKeyResponse>('/api/auth/key', b),
  deleteApiKey: (id: string) => del<void>(`/api/auth/key/${enc(id)}`),
  listUsers: (p?: { page?: number; per_page?: number; role?: number; search?: string }) => get<UserListResponse>('/api/auth/user', p),
  createUser: (b: CreateUserRequest) => post<UserDTO>('/api/auth/user', b),
  deleteUser: (id: number) => del<void>(`/api/auth/user/${enc(String(id))}`),

  createDevice: (b: CreateDeviceRequest) => post<CreateDeviceResponse>('/api/devices', b),
  listDevices: (p?: { status?: string; platform?: string; group?: string; search?: string; page?: number; per_page?: number }) =>
    get<DeviceListResponse>('/api/devices', p),
  getDevice: (id: string) => get<DeviceDTO>(`/api/devices/${enc(id)}`),
  updateDevice: (id: string, b: UpdateDeviceRequest) => req<DeviceDTO>(`/api/devices/${enc(id)}`, 'PATCH', b),
  getDeviceStatus: (id: string) => get<DeviceStatusResponse>('/api/devices/status', { id }),
  deleteDevice: (id: string) => del<void>(`/api/devices/${enc(id)}`),
  batchDeleteDevices: (ids: string[]) => post<{ deleted_count?: number }>('/api/devices/batch-delete', { ids } satisfies BatchDeleteDevicesRequest),

  async listGroups(): Promise<GroupDTO[]> {
    const d = await get<GroupDTO[] | { groups?: GroupDTO[] }>('/api/groups');
    return Array.isArray(d) ? d : d?.groups ?? [];
  },
  createGroup: (b: CreateGroupRequest) => post<GroupDTO>('/api/groups', b),
  updateGroup: (id: string, b: UpdateGroupRequest) => put<GroupDTO>(`/api/groups/${enc(id)}`, b),
  deleteGroup: (id: string) => del<void>(`/api/groups/${enc(id)}`),
  assignGroupDevices: (id: string, deviceIds: string[]) => put<void>(`/api/groups/${enc(id)}/devices`, { device_ids: deviceIds } satisfies GroupDevicesRequest),
  removeGroupDevices: (id: string, deviceIds: string[]) => del<void>(`/api/groups/${enc(id)}/devices`, { device_ids: deviceIds } satisfies GroupDevicesRequest),

  createCommand: (b: CreateCommandRequest) => post<CommandDTO>('/api/commands', b),
  execDeviceCommand: (
    deviceId: string,
    opts: { content: string; name?: string; timeout?: number; shell?: string },
  ) =>
    post<CommandDTO>('/api/commands', {
      name: opts.name ?? `exec: ${opts.content.split('\n')[0].slice(0, 48)}`,
      type: 'immediate',
      content: opts.content,
      target_type: 'devices',
      target_ids: [deviceId],
      timeout: opts.timeout,
      shell: opts.shell && opts.shell !== 'auto' ? opts.shell : undefined,
    } satisfies CreateCommandRequest),
  listCommands: (p?: { status?: string; type?: string; device?: string; page?: number; per_page?: number }) =>
    get<CommandListResponse>('/api/commands', p),
  getCommand: (id: string) => get<CommandDetailDTO>(`/api/commands/${enc(id)}`),
  updateCommandStatus: (id: string, action: CommandAction) => put<void>(`/api/commands/${enc(id)}`, { action } satisfies UpdateCommandStatusRequest),
  getCommandResults: (id: string, p?: { page?: number; per_page?: number }) => get<CommandResultsResponse>(`/api/commands/${enc(id)}/results`, p),

  listCommandLogs: (p?: { device_id?: string; command_id?: string; status?: string; page?: number; per_page?: number }) =>
    get<LogListResponse<CommandLogDTO>>('/api/logs/command', p),
  listDeviceLogs: (p?: { device_id?: string; type?: string; page?: number; per_page?: number }) =>
    get<LogListResponse<DeviceLogDTO>>('/api/logs/device', p),
  listAuditLogs: (p?: { user_id?: number; action?: string; page?: number; per_page?: number }) =>
    get<LogListResponse<AuditLogDTO>>('/api/logs/user', p),

  getSystemInfo: () => get<SystemInfoDTO>('/api/system/info'),
  getHealth: () => get<unknown>('/health', undefined, true),
  async fetchFleet(): Promise<{ devices: DeviceDTO[]; groups: GroupDTO[]; total: number }> {
    const [devRes, groups] = await Promise.all([
      get<DeviceListResponse>('/api/devices', { per_page: 200 }),
      api.listGroups().catch(() => [] as GroupDTO[]),
    ]);
    const devices = devRes.devices ?? [];
    return { devices, groups, total: devRes.total ?? devices.length };
  },
};
