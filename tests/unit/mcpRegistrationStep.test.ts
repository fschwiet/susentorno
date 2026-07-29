import { describe, it, expect } from 'vitest';
import type { McpServer } from '../../src/mcpServers';
import { generateMcpRegistrationScript } from '../../src/mcpRegistrationStep';

const servers: McpServer[] = [
  {
    name: 'filesystem',
    url: 'https://filesystem.mcp.internal/mcp',
    host: 'filesystem.mcp.internal',
    command: 'my-server --bind {ip} --port {port}',
  },
  {
    name: 'other',
    url: 'https://other.mcp.internal',
    host: 'other.mcp.internal',
    command: 'other-server {ip}:{port}',
  },
];

describe('MCP server registration step generation', () => {
  it('registers each server with claude, removing before adding, for each declared server', () => {
    const script = generateMcpRegistrationScript(servers, 'sh');
    const removeIdx = script.indexOf("claude mcp remove 'filesystem'");
    const addIdx = script.indexOf(
      "claude mcp add --transport http 'filesystem' 'https://filesystem.mcp.internal/mcp'",
    );
    expect(removeIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(removeIdx);
    expect(script).toContain("claude mcp remove 'other'");
    expect(script).toContain(
      "claude mcp add --transport http 'other' 'https://other.mcp.internal'",
    );
  });

  it('registers each server with codex, removing before adding', () => {
    const script = generateMcpRegistrationScript(servers, 'sh');
    const removeIdx = script.indexOf("codex mcp remove 'filesystem'");
    const addIdx = script.indexOf(
      "codex mcp add 'filesystem' --url 'https://filesystem.mcp.internal/mcp'",
    );
    expect(removeIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(removeIdx);
  });

  it('guards each agent block with a PATH presence check and a skip message', () => {
    const script = generateMcpRegistrationScript(servers, 'sh');
    expect(script).toContain('if command -v claude >/dev/null 2>&1; then');
    expect(script).toContain('claude CLI not found on PATH; skipping claude registration');
    expect(script).toContain('if command -v codex >/dev/null 2>&1; then');
    expect(script).toContain('codex CLI not found on PATH; skipping codex registration');
  });

  it('ignores the removal outcome (best-effort) but checks the add outcome', () => {
    const script = generateMcpRegistrationScript(servers, 'sh');
    expect(script).toContain("claude mcp remove 'filesystem' >/dev/null 2>&1\n");
    expect(script).toContain("if ! claude mcp add --transport http 'filesystem'");
  });

  it('produces the same structure and ordering in the .ps1 variant', () => {
    const script = generateMcpRegistrationScript(servers, 'ps1');
    expect(script).toContain('if (Get-Command claude -ErrorAction SilentlyContinue) {');
    const removeIdx = script.indexOf("claude mcp remove 'filesystem'");
    const addIdx = script.indexOf(
      "claude mcp add --transport http 'filesystem' 'https://filesystem.mcp.internal/mcp'",
    );
    expect(removeIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(removeIdx);
    expect(script).toContain('claude CLI not found on PATH; skipping claude registration');
    expect(script).toContain('if (Get-Command codex -ErrorAction SilentlyContinue) {');
    expect(script).toContain(
      "codex mcp add 'filesystem' --url 'https://filesystem.mcp.internal/mcp'",
    );
    expect(script).toContain('codex CLI not found on PATH; skipping codex registration');
  });

  it('generates an empty (no-op) step body when no servers are declared', () => {
    const shScript = generateMcpRegistrationScript([], 'sh');
    const ps1Script = generateMcpRegistrationScript([], 'ps1');
    expect(shScript).not.toContain('claude mcp add');
    expect(ps1Script).not.toContain('claude mcp add');
  });
});
