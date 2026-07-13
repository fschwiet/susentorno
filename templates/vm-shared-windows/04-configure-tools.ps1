$ErrorActionPreference = 'Stop'

# Never sleep / never blank the display (analog of Ubuntu's screensaver disable).
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /change monitor-timeout-ac 0
powercfg /change monitor-timeout-dc 0

# Register the context7 MCP server for both agents (mirrors Ubuntu 04).
claude mcp add --transport http context7 https://mcp.context7.com/mcp
codex mcp add context7 --url https://mcp.context7.com/mcp

Write-Host "04-configure-tools: power timeouts disabled; context7 MCP registered for claude and codex."
