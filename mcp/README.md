# CSLite MCP Server (`cslite-mcp`)

Zero-dependency stdio MCP (Model Context Protocol) server that lets local AI assistants control remote nodes (Colab containers, VPS, OpenWrt routers, macOS/Windows hosts) through a CSLite control plane using an API key.

## 1. Prerequisites

1. **Create an unbound management API Key in CSLite**:
   - Sign in to your CSLite web UI -> **Settings -> API Keys** (or `POST /api/auth/key`).
   - Create a key **without binding it to a specific device** (`device_id: null`).
   - Note: Device-scoped keys (`ak_...` bound to a device) are restricted to agent polling/reporting and will return `403` on management APIs.
2. **Build the standalone MCP bundle**:
   ```bash
   npm run build:mcp
   ```
   This outputs `mcp/dist/cslite-mcp.mjs`.

## 2. Client Configuration

Add `cslite` to your MCP client configuration (Claude Desktop, Cursor, Antigravity, Claude Code, etc.):

```json
{
  "mcpServers": {
    "cslite": {
      "command": "node",
      "args": ["/abs/path/to/Cslite/mcp/dist/cslite-mcp.mjs"],
      "env": {
        "CSLITE_URL": "https://your-cslite-domain",
        "CSLITE_API_KEY": "ak_live_your_unbound_management_key"
      }
    }
  }
}
```

## 3. Exposed MCP Tools

| Tool | Description |
| :--- | :--- |
| `cslite_list_devices` | List devices with optional `status`, `search`, `group`, `page`, `per_page` filters |
| `cslite_get_device` | Fetch device metadata, interface IPs, and latest hardware metrics |
| `cslite_run_command` | Dispatch an immediate shell command to target `devices` or `groups` and optionally poll until completion |
| `cslite_get_command` | Fetch command status, execution history, exit codes, and full output |
| `cslite_cancel_command` | Cancel, pause, or resume a command |
| `cslite_list_logs` | Query `command`, `device`, or `user` audit logs |

## 4. Colab / Container Onboarding

In a Google Colab cell (or any Linux container without `systemd`):

```sh
!curl -fsSL https://your-cslite-domain/i | sh -s -- "<DEVICE_API_KEY>" "<DEVICE_ID>" "colab-gpu"
```

Starting with `v1.2.1`, `install.sh` and `cslite-agent` detect containers lacking `/run/systemd/system` even when `systemctl` exists and automatically fall back to `nohup` background execution.
