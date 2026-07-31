import { describe, it, expect } from 'vitest';
import { generateMcpPostScript } from '../../src/mcpPostScript';
import type { McpServerConfig } from '../../src/mcpServers';

const servers: McpServerConfig[] = [
  { name: 'filesystem', hostname: 'filesystem.internal', command: 'x' },
  { name: 'git', hostname: 'git.internal', command: 'y' },
];

describe('generateMcpPostScript', () => {
  it('returns an empty string when there are no servers', () => {
    expect(generateMcpPostScript([], 'sh')).toBe('');
    expect(generateMcpPostScript([], 'ps1')).toBe('');
  });

  it('emits a remove-then-add pair per server per CLI for sh, claude scoped to user', () => {
    const script = generateMcpPostScript(servers, 'sh');
    expect(script).toContain('claude mcp remove --scope user filesystem || true');
    expect(script).toContain('claude mcp add --scope user --transport http filesystem https://filesystem.internal');
    expect(script).toContain('codex mcp remove filesystem || true');
    expect(script).toContain('codex mcp add filesystem --url https://filesystem.internal');
    expect(script).toContain('claude mcp remove --scope user git || true');
    expect(script).toContain('codex mcp add git --url https://git.internal');
  });

  it('emits the ps1 equivalent without a bash-style || true', () => {
    const script = generateMcpPostScript(servers, 'ps1');
    expect(script).toContain('claude mcp remove --scope user filesystem');
    expect(script).toContain('claude mcp add --scope user --transport http filesystem https://filesystem.internal');
    expect(script).toContain('codex mcp remove filesystem');
    expect(script).toContain('codex mcp add filesystem --url https://filesystem.internal');
    expect(script).not.toContain('|| true');
  });
});
