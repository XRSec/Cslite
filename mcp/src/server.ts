import readline from 'node:readline';
import type { CsliteClient, ListDevicesParams, ListLogsParams, RunCommandParams } from './client';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'cslite_list_devices',
    description:
      'List devices registered in CSLite (e.g., Colab containers, VPS, OpenWrt routers). Supports filtering by status, search keyword, or group.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['online', 'offline'], description: 'Filter by online/offline status' },
        search: { type: 'string', description: 'Search by device name, ID, hostname, or IP' },
        group: { type: 'string', description: 'Filter by group ID or name' },
        page: { type: 'integer', minimum: 1 },
        per_page: { type: 'integer', minimum: 1, maximum: 200 },
      },
    },
  },
  {
    name: 'cslite_get_device',
    description: 'Get detailed information and latest hardware metrics (CPU, memory, disk, IPs) for a specific device.',
    inputSchema: {
      type: 'object',
      properties: {
        device_id: { type: 'string', description: 'Target device ID (e.g., dev_...)' },
      },
      required: ['device_id'],
    },
  },
  {
    name: 'cslite_run_command',
    description:
      'Execute a shell command on one or more CSLite devices (or groups). By default waits and polls until completion and returns exit codes + stdout/stderr.',
    inputSchema: {
      type: 'object',
      properties: {
        target_ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Target device IDs (or group IDs when target_type is "groups")',
        },
        target_type: {
          type: 'string',
          enum: ['devices', 'groups'],
          default: 'devices',
        },
        content: { type: 'string', description: 'Shell command or script to execute' },
        name: { type: 'string', description: 'Optional human-readable command label' },
        timeout: { type: 'integer', minimum: 1, maximum: 86400, default: 60, description: 'Agent execution timeout in seconds' },
        shell: { type: 'string', description: 'Optional shell binary (e.g., bash, sh, pwsh)' },
        env_vars: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Optional environment variables map',
        },
        wait: {
          type: 'boolean',
          default: true,
          description: 'Wait for command completion. Set false for long-running jobs and poll with cslite_get_command.',
        },
        wait_timeout_sec: {
          type: 'integer',
          minimum: 1,
          maximum: 600,
          description: 'Maximum seconds to wait when wait=true',
        },
      },
      required: ['target_ids', 'content'],
    },
  },
  {
    name: 'cslite_get_command',
    description: 'Get the current status, execution history, exit codes, and output of a CSLite command by command_id.',
    inputSchema: {
      type: 'object',
      properties: {
        command_id: { type: 'string', description: 'Command ID returned by cslite_run_command' },
      },
      required: ['command_id'],
    },
  },
  {
    name: 'cslite_cancel_command',
    description: 'Cancel, pause, or resume a CSLite command.',
    inputSchema: {
      type: 'object',
      properties: {
        command_id: { type: 'string', description: 'Target command ID' },
        action: { type: 'string', enum: ['cancel', 'pause', 'resume'], default: 'cancel' },
      },
      required: ['command_id'],
    },
  },
  {
    name: 'cslite_list_logs',
    description: 'Query command execution, device/health, or user audit logs from CSLite.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['command', 'device', 'user'], default: 'device' },
        device_id: { type: 'string', description: 'Filter logs by device ID' },
        level: { type: 'string', description: 'Filter logs by level (info, warn, error)' },
        page: { type: 'integer', minimum: 1 },
        per_page: { type: 'integer', minimum: 1, maximum: 200 },
      },
    },
  },
];

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asOptionalInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : undefined;
}

export function createMcpServer(client: CsliteClient) {
  async function callTool(name: string, args: Record<string, unknown> = {}) {
    switch (name) {
      case 'cslite_list_devices': {
        const params: ListDevicesParams = {
          status: asString(args.status) || undefined,
          search: asString(args.search) || undefined,
          group: asString(args.group) || undefined,
          page: asOptionalInt(args.page),
          per_page: asOptionalInt(args.per_page),
        };
        return client.listDevices(params);
      }
      case 'cslite_get_device': {
        return client.getDevice(asString(args.device_id));
      }
      case 'cslite_run_command': {
        const targetIds = Array.isArray(args.target_ids)
          ? args.target_ids.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
          : [];
        const params: RunCommandParams = {
          target_ids: targetIds,
          target_type: args.target_type === 'groups' ? 'groups' : 'devices',
          content: asString(args.content),
          name: asString(args.name) || undefined,
          timeout: asOptionalInt(args.timeout),
          shell: asString(args.shell) || undefined,
          env_vars:
            args.env_vars && typeof args.env_vars === 'object' && !Array.isArray(args.env_vars)
              ? (args.env_vars as Record<string, string>)
              : undefined,
          wait: typeof args.wait === 'boolean' ? args.wait : true,
          wait_timeout_sec: asOptionalInt(args.wait_timeout_sec),
        };
        return client.runCommandAndWait(params);
      }
      case 'cslite_get_command': {
        return client.getCommand(asString(args.command_id));
      }
      case 'cslite_cancel_command': {
        const rawAction = asString(args.action);
        const action =
          rawAction === 'pause' || rawAction === 'resume' || rawAction === 'cancel'
            ? rawAction
            : 'cancel';
        return client.updateCommandStatus(asString(args.command_id), action);
      }
      case 'cslite_list_logs': {
        const rawType = asString(args.type);
        const type =
          rawType === 'command' || rawType === 'user' || rawType === 'device' ? rawType : undefined;
        const params: ListLogsParams = {
          type,
          device_id: asString(args.device_id) || undefined,
          level: asString(args.level) || undefined,
          page: asOptionalInt(args.page),
          per_page: asOptionalInt(args.per_page),
        };
        return client.listLogs(params);
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = req.id ?? null;

    // Notifications do not have an id and must not receive a response.
    if (req.id === undefined && req.method.startsWith('notifications/')) {
      return null;
    }

    switch (req.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'cslite-mcp', version: '1.2.2' },
          },
        };
      case 'notifications/initialized':
        return null;
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
      case 'tools/call': {
        const toolName = asString(req.params?.name);
        const toolArgs =
          req.params?.arguments && typeof req.params.arguments === 'object'
            ? (req.params.arguments as Record<string, unknown>)
            : {};
        try {
          const data = await callTool(toolName, toolArgs);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
              isError: false,
            },
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: msg }],
              isError: true,
            },
          };
        }
      }
      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        };
    }
  }

  return { handleRequest };
}

export function startStdioServer(
  server: ReturnType<typeof createMcpServer>,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): void {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      const errResp: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      };
      output.write(`${JSON.stringify(errResp)}\n`);
      return;
    }
    const resp = await server.handleRequest(req);
    if (resp) {
      output.write(`${JSON.stringify(resp)}\n`);
    }
  });
}
