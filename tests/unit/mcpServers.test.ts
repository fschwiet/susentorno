import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseMcpServers,
  readMcpServers,
  resolveMcpAllowlistCollisions,
} from '../../src/mcpServers';
import type { Allowlist } from '../../src/allowlist';

describe('mcp-servers.yaml parsing & validation', () => {
  it('parses a valid file with all fields', () => {
    const content = [
      'servers:',
      '  - name: filesystem',
      '    hostname: filesystem.internal',
      '    command: npx -y @modelcontextprotocol/server-filesystem {ip} {port} /allowed',
      '    cwd: /home/me/project',
      '    env:',
      '      SOME_TOKEN: abc123',
      '',
    ].join('\n');

    expect(parseMcpServers(content)).toEqual([
      {
        name: 'filesystem',
        hostname: 'filesystem.internal',
        command: 'npx -y @modelcontextprotocol/server-filesystem {ip} {port} /allowed',
        cwd: '/home/me/project',
        env: { SOME_TOKEN: 'abc123' },
      },
    ]);
  });

  it('parses a minimal entry with only the required fields', () => {
    const content = [
      'servers:',
      '  - name: fs',
      '    hostname: fs.internal',
      '    command: fs-cmd',
      '',
    ].join('\n');
    expect(parseMcpServers(content)).toEqual([
      { name: 'fs', hostname: 'fs.internal', command: 'fs-cmd', cwd: undefined, env: undefined },
    ]);
  });

  it('throws on invalid YAML', () => {
    expect(() => parseMcpServers('servers: [')).toThrow('not valid YAML');
  });

  it("throws when there is no top-level 'servers' list", () => {
    expect(() => parseMcpServers('foo: bar\n')).toThrow("top-level 'servers' list");
  });

  it('throws when name has invalid characters', () => {
    const content = [
      'servers:',
      '  - name: "bad name!"',
      '    hostname: fs.internal',
      '    command: x',
      '',
    ].join('\n');
    expect(() => parseMcpServers(content)).toThrow('servers[0].name');
  });

  it('throws when hostname is not a valid DNS hostname', () => {
    const content = [
      'servers:',
      '  - name: fs',
      '    hostname: "not a host!"',
      '    command: x',
      '',
    ].join('\n');
    expect(() => parseMcpServers(content)).toThrow('servers[0].hostname');
  });

  it('throws when command is missing', () => {
    const content = ['servers:', '  - name: fs', '    hostname: fs.internal', ''].join('\n');
    expect(() => parseMcpServers(content)).toThrow('servers[0].command');
  });

  it('throws on a duplicate name', () => {
    const content = [
      'servers:',
      '  - name: fs',
      '    hostname: a.internal',
      '    command: x',
      '  - name: fs',
      '    hostname: b.internal',
      '    command: y',
      '',
    ].join('\n');
    expect(() => parseMcpServers(content)).toThrow("duplicate server name 'fs'");
  });

  it('throws on a duplicate hostname', () => {
    const content = [
      'servers:',
      '  - name: fs',
      '    hostname: shared.internal',
      '    command: x',
      '  - name: git',
      '    hostname: shared.internal',
      '    command: y',
      '',
    ].join('\n');
    expect(() => parseMcpServers(content)).toThrow("duplicate server hostname 'shared.internal'");
  });
});

describe('readMcpServers', () => {
  it('returns an empty list when the file does not exist', () => {
    expect(readMcpServers('/definitely/not/a/real/path/mcp-servers.yaml')).toEqual([]);
  });

  it('reads and parses an existing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-servers-test-'));
    const path = join(dir, 'mcp-servers.yaml');
    writeFileSync(
      path,
      ['servers:', '  - name: fs', '    hostname: fs.internal', '    command: x', ''].join('\n'),
    );
    try {
      expect(readMcpServers(path)).toEqual([
        { name: 'fs', hostname: 'fs.internal', command: 'x', cwd: undefined, env: undefined },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveMcpAllowlistCollisions', () => {
  const baseAllowlist: Allowlist = {
    passthrough: [],
    claudeAuthenticated: [],
    githubAuthenticated: [],
    codexAuthenticated: [],
    authCandidate: [],
    blocked: [],
    warnings: [],
  };

  it('removes a passthrough entry that collides with an MCP hostname and warns', () => {
    const allowlist: Allowlist = {
      ...baseAllowlist,
      passthrough: ['filesystem.internal:443', 'other.com:443'],
    };
    const servers = [{ name: 'fs', hostname: 'filesystem.internal', command: 'x' }];

    const resolved = resolveMcpAllowlistCollisions(allowlist, servers);

    expect(resolved.passthrough).toEqual(['other.com:443']);
    expect(resolved.warnings).toEqual([
      "collision: 'filesystem.internal:443' listed in passthrough and mcp-servers.yaml; using mcp-servers.yaml",
    ]);
  });

  it('checks every section, not just passthrough', () => {
    const allowlist: Allowlist = { ...baseAllowlist, claudeAuthenticated: ['fs.internal:443'] };
    const servers = [{ name: 'fs', hostname: 'fs.internal', command: 'x' }];

    const resolved = resolveMcpAllowlistCollisions(allowlist, servers);

    expect(resolved.claudeAuthenticated).toEqual([]);
    expect(resolved.warnings).toEqual([
      "collision: 'fs.internal:443' listed in claudeAuthenticated and mcp-servers.yaml; using mcp-servers.yaml",
    ]);
  });

  it('does not modify or warn when there is no collision', () => {
    const allowlist: Allowlist = { ...baseAllowlist, passthrough: ['unrelated.com:443'] };
    const servers = [{ name: 'fs', hostname: 'fs.internal', command: 'x' }];

    const resolved = resolveMcpAllowlistCollisions(allowlist, servers);

    expect(resolved).toEqual(allowlist);
  });

  it('preserves pre-existing warnings alongside any new collision warnings', () => {
    const allowlist: Allowlist = { ...baseAllowlist, warnings: ['pre-existing warning'] };
    const resolved = resolveMcpAllowlistCollisions(allowlist, []);
    expect(resolved.warnings).toEqual(['pre-existing warning']);
  });
});

describe('resolveMcpAllowlistCollisions — block-list', () => {
  const baseAllowlist: Allowlist = {
    passthrough: [],
    claudeAuthenticated: [],
    githubAuthenticated: [],
    codexAuthenticated: [],
    authCandidate: [],
    blocked: [],
    warnings: [],
  };

  it('removes an exact block-list entry that collides with an MCP hostname and warns', () => {
    const resolved = resolveMcpAllowlistCollisions(
      { ...baseAllowlist, blocked: ['filesystem.internal', 'other.blocked'] },
      [{ name: 'fs', hostname: 'filesystem.internal', command: 'x' }],
    );
    expect(resolved.blocked).toEqual(['other.blocked']);
    expect(resolved.warnings).toEqual([
      "collision: 'filesystem.internal' listed in block-list.txt and mcp-servers.yaml; MCP servers are not subject to block-list pruning, so it stays reachable",
    ]);
  });

  it('leaves a matching wildcard block-list entry in place but warns', () => {
    const resolved = resolveMcpAllowlistCollisions({ ...baseAllowlist, blocked: ['*.internal'] }, [
      { name: 'fs', hostname: 'filesystem.internal', command: 'x' },
    ]);
    expect(resolved.blocked).toEqual(['*.internal']);
    expect(resolved.warnings).toEqual([
      "collision: 'filesystem.internal' listed in block-list.txt and mcp-servers.yaml; MCP servers are not subject to block-list pruning, so it stays reachable",
    ]);
  });

  it('does not warn for a non-matching wildcard', () => {
    const allowlist = { ...baseAllowlist, blocked: ['*.other'] };
    expect(
      resolveMcpAllowlistCollisions(allowlist, [
        { name: 'fs', hostname: 'filesystem.internal', command: 'x' },
      ]),
    ).toEqual(allowlist);
  });
});
