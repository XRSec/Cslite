---
name: cslite-remote
description: Operate remote Linux/Colab/OpenWrt/macOS/Windows hosts through CSLite MCP (`cslite-mcp`) using an unbound management API key. Use when asked to inspect remote nodes, check GPU/CPU/memory metrics, run shell commands on Colab or VPS nodes, or tail command outputs/logs via CSLite.
---

# CSLite Remote Control (`本机 -> CSLite -> Colab / VPS`)

Use the `cslite` MCP tools to inspect and execute commands on remote machines connected to your CSLite control plane without SSH or public ports.

## Prerequisites

- The `cslite` MCP server (`mcp/dist/cslite-mcp.mjs`) must be configured with:
  - `CSLITE_URL`: Your CSLite server base URL (e.g. `https://your-cslite-domain`).
  - `CSLITE_API_KEY`: An **unbound management API key** (`ak_...`, not bound to a single device).
- Target nodes (such as a Google Colab runtime) must be running `cslite-agent` (v1.2.1+ automatically falls back to `nohup` in containers without `/run/systemd/system`).

## Workflow

1. **Discover online nodes first**:
   - Call `cslite_list_devices` (e.g. `status: "online"` or `search: "colab"`).
   - Never guess a `device_id`; pick the exact `id` (`dev_...`) from `cslite_list_devices`.
2. **Inspect node state if needed**:
   - Call `cslite_get_device` with `device_id` to check `metrics` (CPU, memory, disk, IPs) and `agent_version` before launching heavy workloads.
3. **Run commands**:
   - **Short commands** (e.g. `nvidia-smi`, `ls`, `df -h`, `git status`):
     - Call `cslite_run_command` with `target_ids: ["<device_id>"]`, `content: "<cmd>"`, and `wait: true` (default).
   - **Long-running jobs** (e.g. model training, large downloads, builds > 60s):
     - Call `cslite_run_command` with `wait: false` and an appropriate `timeout` (up to `86400`s), or redirect long logs to a file on the remote node and inspect progress via `cslite_get_command` (`command_id`).
   - **Aborting**:
     - Use `cslite_cancel_command` with `command_id` and `action: "cancel"`.
4. **Troubleshoot**:
   - Use `cslite_list_logs` (`type: "device"` or `"command"`, `device_id`) to inspect recent agent, health, or command logs.
