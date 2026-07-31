import type { McpServerConfig } from './mcpServers';

/**
 * Unconditional remove-then-add per server, per CLI: converges additions/edits on
 * every re-run (a server whose hostname changed gets re-registered), but does NOT
 * remove a server deleted or renamed out of mcp-servers.yaml — that's a documented,
 * accepted manual step (see the design spec). `codex mcp` has no --scope flag.
 */
export function generateMcpPostScript(servers: McpServerConfig[], platform: 'sh' | 'ps1'): string {
  if (servers.length === 0) return '';

  const lines: string[] = [];
  for (const server of servers) {
    const url = `https://${server.hostname}`;
    if (platform === 'sh') {
      lines.push(
        `claude mcp remove --scope user ${server.name} || true`,
        `claude mcp add --scope user --transport http ${server.name} ${url}`,
        `codex mcp remove ${server.name} || true`,
        `codex mcp add ${server.name} --url ${url}`,
      );
    } else {
      // PowerShell doesn't abort the script on a native command's non-zero exit
      // (unlike bash's `set -e`), so a "not found" remove needs no || true equivalent.
      lines.push(
        `claude mcp remove --scope user ${server.name}`,
        `claude mcp add --scope user --transport http ${server.name} ${url}`,
        `codex mcp remove ${server.name}`,
        `codex mcp add ${server.name} --url ${url}`,
      );
    }
  }

  const shebang = platform === 'sh' ? '#!/bin/bash\n\n' : '';
  return `${shebang}${lines.join('\n')}\n`;
}
