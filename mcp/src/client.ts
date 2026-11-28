import type {
  CommandDetailDTO,
  CreateCommandRequest,
  DeviceDTO,
  DeviceListResponse,
  ExecutionDeviceResultDTO,
  LogListResponse,
} from '../../shared/types';

export interface ApiEnvelope<T = unknown> {
  code: number;
  message: string;
  data: T;
}

export interface CsliteClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export interface ListDevicesParams {
  status?: string;
  search?: string;
  group?: string;
  page?: number;
  per_page?: number;
}

export interface RunCommandParams {
  target_ids: string[];
  target_type?: 'devices' | 'groups';
  content: string;
  name?: string;
  timeout?: number;
  shell?: string;
  env_vars?: Record<string, string>;
  wait?: boolean;
  wait_timeout_sec?: number;
  poll_interval_ms?: number;
}

export interface RunCommandResult {
  command_id: string;
  status: string;
  waited: boolean;
  timed_out_waiting: boolean;
  results: ExecutionDeviceResultDTO[];
}

export interface ListLogsParams {
  type?: 'command' | 'device' | 'user';
  device_id?: string;
  level?: string;
  page?: number;
  per_page?: number;
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'timeout', 'cancelled']);

export class CsliteApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly apiCode?: number,
  ) {
    super(message);
    this.name = 'CsliteApiError';
  }
}

export class CsliteClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: CsliteClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey.trim();
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    if (!this.baseUrl) {
      throw new Error('CSLITE_URL is required');
    }
    if (!this.apiKey) {
      throw new Error('CSLITE_API_KEY is required');
    }
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = new Headers(init.headers);
      headers.set('X-API-Key', this.apiKey);
      headers.set('Accept', 'application/json');
      if (init.body !== undefined && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }

      const res = await this.fetchFn(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });

      const text = await res.text();
      let parsed: ApiEnvelope<T> | null = null;
      if (text) {
        try {
          parsed = JSON.parse(text) as ApiEnvelope<T>;
        } catch {
          throw new CsliteApiError(
            `Invalid JSON response (${res.status}): ${text.slice(0, 200)}`,
            res.status,
          );
        }
      }

      if (!res.ok || !parsed || parsed.code >= 40000) {
        const msg = parsed?.message || `HTTP ${res.status}`;
        throw new CsliteApiError(msg, res.status, parsed?.code);
      }
      return parsed.data;
    } finally {
      clearTimeout(timer);
    }
  }

  async listDevices(params: ListDevicesParams = {}): Promise<DeviceListResponse> {
    const q = new URLSearchParams();
    if (params.status) q.set('status', params.status);
    if (params.search) q.set('search', params.search);
    if (params.group) q.set('group', params.group);
    if (params.page) q.set('page', String(params.page));
    if (params.per_page) q.set('per_page', String(params.per_page));
    const qs = q.toString();
    return this.request<DeviceListResponse>(`/api/devices${qs ? `?${qs}` : ''}`);
  }

  async getDevice(deviceId: string): Promise<DeviceDTO> {
    if (!deviceId.trim()) throw new Error('device_id is required');
    return this.request<DeviceDTO>(`/api/devices/${encodeURIComponent(deviceId.trim())}`);
  }

  async createCommand(req: CreateCommandRequest): Promise<{ id: string }> {
    return this.request<{ id: string }>('/api/commands', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  async getCommand(commandId: string): Promise<CommandDetailDTO> {
    if (!commandId.trim()) throw new Error('command_id is required');
    return this.request<CommandDetailDTO>(`/api/commands/${encodeURIComponent(commandId.trim())}`);
  }

  async updateCommandStatus(
    commandId: string,
    action: 'pause' | 'resume' | 'cancel',
  ): Promise<{ id: string; status: string }> {
    if (!commandId.trim()) throw new Error('command_id is required');
    return this.request<{ id: string; status: string }>(
      `/api/commands/${encodeURIComponent(commandId.trim())}`,
      {
        method: 'PUT',
        body: JSON.stringify({ action }),
      },
    );
  }

  async listLogs(params: ListLogsParams = {}): Promise<LogListResponse<unknown>> {
    const logType = params.type ?? 'device';
    const q = new URLSearchParams();
    if (params.device_id) q.set('device_id', params.device_id);
    if (params.level) q.set('level', params.level);
    if (params.page) q.set('page', String(params.page));
    if (params.per_page) q.set('per_page', String(params.per_page));
    const qs = q.toString();
    return this.request<LogListResponse<unknown>>(`/api/logs/${logType}${qs ? `?${qs}` : ''}`);
  }

  async runCommandAndWait(params: RunCommandParams): Promise<RunCommandResult> {
    const content = params.content?.trim() ? params.content : '';
    if (!content) throw new Error('content is required');
    if (!Array.isArray(params.target_ids) || params.target_ids.length === 0) {
      throw new Error('target_ids must be a non-empty array');
    }

    const timeout = params.timeout ?? 60;
    const autoName = `mcp: ${content.replace(/\s+/g, ' ').slice(0, 48)}`;
    const created = await this.createCommand({
      name: params.name?.trim() || autoName,
      type: 'immediate',
      content,
      target_type: params.target_type ?? 'devices',
      target_ids: params.target_ids,
      timeout,
      shell: params.shell,
      env_vars: params.env_vars,
    });

    const shouldWait = params.wait !== false;
    if (!shouldWait) {
      return {
        command_id: created.id,
        status: 'pending',
        waited: false,
        timed_out_waiting: false,
        results: [],
      };
    }

    const waitTimeoutMs = Math.max(1000, (params.wait_timeout_sec ?? Math.min(timeout + 15, 120)) * 1000);
    const pollIntervalMs = Math.max(100, params.poll_interval_ms ?? 1000);
    const deadline = Date.now() + waitTimeoutMs;

    let detail = await this.getCommand(created.id);
    while (!TERMINAL_STATUSES.has(detail.status) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, Math.max(50, deadline - Date.now()))));
      detail = await this.getCommand(created.id);
    }

    const latestExec = detail.execution_history?.[0];
    return {
      command_id: created.id,
      status: detail.status,
      waited: true,
      timed_out_waiting: !TERMINAL_STATUSES.has(detail.status),
      results: latestExec?.device_results ?? [],
    };
  }
}
