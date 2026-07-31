import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMcpServers, readMcpServers } from '../../src/mcpServers';

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
    const content = ['servers:', '  - name: fs', '    hostname: fs.internal', '    command: fs-cmd', ''].join(
      '\n',
    );
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
    const content = ['servers:', '  - name: "bad name!"', '    hostname: fs.internal', '    command: x', ''].join(
      '\n',
    );
    expect(() => parseMcpServers(content)).toThrow('servers[0].name');
  });

  it('throws when hostname is not a valid DNS hostname', () => {
    const content = ['servers:', '  - name: fs', '    hostname: "not a host!"', '    command: x', ''].join('\n');
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
