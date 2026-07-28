import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMcpServers } from '../../src/mcpServers';

let envRoot: string;
beforeEach(() => {
  envRoot = mkdtempSync(join(tmpdir(), 'mcp-'));
});
afterEach(() => rmSync(envRoot, { recursive: true, force: true }));

describe('mcp-servers.yaml parsing & validation', () => {
  it('parses a well-formed flat list into records', () => {
    const content = [
      '- name: filesystem',
      '  url: https://filesystem.mcp.internal/mcp',
      '  command: "my-server --bind {ip} --port {port}"',
      '- name: other',
      '  url: https://other.mcp.internal',
      '  command: "other-server {ip}:{port}"',
    ].join('\n');

    expect(parseMcpServers(content, { envRoot })).toEqual([
      {
        name: 'filesystem',
        url: 'https://filesystem.mcp.internal/mcp',
        host: 'filesystem.mcp.internal',
        command: 'my-server --bind {ip} --port {port}',
        workingDir: undefined,
      },
      {
        name: 'other',
        url: 'https://other.mcp.internal',
        host: 'other.mcp.internal',
        command: 'other-server {ip}:{port}',
        workingDir: undefined,
      },
    ]);
  });

  it('returns an empty list for empty content', () => {
    expect(parseMcpServers('', { envRoot })).toEqual([]);
  });

  it('rejects a duplicate name', () => {
    const content = [
      '- name: dup',
      '  url: https://a.mcp.internal',
      '  command: "x {ip} {port}"',
      '- name: dup',
      '  url: https://b.mcp.internal',
      '  command: "y {ip} {port}"',
    ].join('\n');

    expect(() => parseMcpServers(content, { envRoot })).toThrow("duplicate name 'dup'");
  });

  it('rejects two records whose canonicalized hostnames are equal', () => {
    const content = [
      '- name: a',
      '  url: https://Shared.mcp.internal',
      '  command: "x {ip} {port}"',
      '- name: b',
      '  url: https://shared.mcp.internal',
      '  command: "y {ip} {port}"',
    ].join('\n');

    expect(() => parseMcpServers(content, { envRoot })).toThrow(
      "duplicate hostname 'shared.mcp.internal'",
    );
  });

  it('rejects a hostname equal to an allowlist entry', () => {
    const content = [
      '- name: a',
      '  url: https://api.anthropic.com',
      '  command: "x {ip} {port}"',
    ].join('\n');

    expect(() =>
      parseMcpServers(content, { envRoot, allowlistHosts: ['api.anthropic.com'] }),
    ).toThrow('collides with an allowlist entry');
  });

  it('canonicalizes (lowercases) the host component on the parsed record', () => {
    const content = [
      '- name: a',
      '  url: https://Filesystem.MCP.Internal/mcp',
      '  command: "x {ip} {port}"',
    ].join('\n');

    expect(parseMcpServers(content, { envRoot })[0].host).toBe('filesystem.mcp.internal');
  });

  describe('url profile rejections', () => {
    it('rejects a non-https url', () => {
      const content = [
        '- name: a',
        '  url: http://a.mcp.internal',
        '  command: "x {ip} {port}"',
      ].join('\n');
      expect(() => parseMcpServers(content, { envRoot })).toThrow("'url' must be https");
    });

    it('rejects a url with userinfo', () => {
      const content = [
        '- name: a',
        '  url: https://user:pass@a.mcp.internal',
        '  command: "x {ip} {port}"',
      ].join('\n');
      expect(() => parseMcpServers(content, { envRoot })).toThrow('userinfo');
    });

    it('rejects a url with a fragment', () => {
      const content = [
        '- name: a',
        '  url: https://a.mcp.internal/mcp#frag',
        '  command: "x {ip} {port}"',
      ].join('\n');
      expect(() => parseMcpServers(content, { envRoot })).toThrow('fragment');
    });

    it('rejects a non-443 explicit port', () => {
      const content = [
        '- name: a',
        '  url: https://a.mcp.internal:8443',
        '  command: "x {ip} {port}"',
      ].join('\n');
      expect(() => parseMcpServers(content, { envRoot })).toThrow('443');
    });

    it('accepts an explicit :443 port', () => {
      const content = [
        '- name: a',
        '  url: https://a.mcp.internal:443',
        '  command: "x {ip} {port}"',
      ].join('\n');
      expect(parseMcpServers(content, { envRoot })[0].host).toBe('a.mcp.internal');
    });

    it('rejects an IPv4-literal host', () => {
      const content = [
        '- name: a',
        '  url: https://127.0.0.1/mcp',
        '  command: "x {ip} {port}"',
      ].join('\n');
      expect(() => parseMcpServers(content, { envRoot })).toThrow('IP literal');
    });

    it('rejects an IPv6-literal host', () => {
      const content = ['- name: a', '  url: https://[::1]/mcp', '  command: "x {ip} {port}"'].join(
        '\n',
      );
      expect(() => parseMcpServers(content, { envRoot })).toThrow('IP literal');
    });

    it('accepts a path and query on the url', () => {
      const content = [
        '- name: a',
        '  url: https://a.mcp.internal/mcp?x=1',
        '  command: "x {ip} {port}"',
      ].join('\n');
      expect(parseMcpServers(content, { envRoot })[0].url).toBe('https://a.mcp.internal/mcp?x=1');
    });
  });

  describe('command placeholder rejections', () => {
    it('rejects a command missing {ip}', () => {
      const content = [
        '- name: a',
        '  url: https://a.mcp.internal',
        '  command: "x --port {port}"',
      ].join('\n');
      expect(() => parseMcpServers(content, { envRoot })).toThrow('{ip}');
    });

    it('rejects a command missing {port}', () => {
      const content = [
        '- name: a',
        '  url: https://a.mcp.internal',
        '  command: "x --ip {ip}"',
      ].join('\n');
      expect(() => parseMcpServers(content, { envRoot })).toThrow('{port}');
    });
  });

  describe('workingDir', () => {
    it('resolves a relative workingDir against the environment root', () => {
      mkdirSync(join(envRoot, 'sub'));
      const content = [
        '- name: a',
        '  url: https://a.mcp.internal',
        '  command: "x {ip} {port}"',
        '  workingDir: sub',
      ].join('\n');
      expect(parseMcpServers(content, { envRoot })[0].workingDir).toBe(join(envRoot, 'sub'));
    });

    it('rejects a workingDir that does not resolve to an existing directory', () => {
      const content = [
        '- name: a',
        '  url: https://a.mcp.internal',
        '  command: "x {ip} {port}"',
        '  workingDir: missing',
      ].join('\n');
      expect(() => parseMcpServers(content, { envRoot })).toThrow(
        "'workingDir' does not resolve to an existing directory",
      );
    });
  });

  it('rejects a missing required field with a loud error, not a silent drop', () => {
    const content = ['- name: a', '  command: "x {ip} {port}"'].join('\n');
    expect(() => parseMcpServers(content, { envRoot })).toThrow("'url' is required");
  });

  it('rejects a missing name', () => {
    const content = ['- url: https://a.mcp.internal', '  command: "x {ip} {port}"'].join('\n');
    expect(() => parseMcpServers(content, { envRoot })).toThrow("'name' is required");
  });

  it('rejects a missing command', () => {
    const content = ['- name: a', '  url: https://a.mcp.internal'].join('\n');
    expect(() => parseMcpServers(content, { envRoot })).toThrow("'command' is required");
  });

  it('rejects a hostname equal to an allowlist entry regardless of case', () => {
    const content = [
      '- name: a',
      '  url: https://Shared.mcp.internal',
      '  command: "x {ip} {port}"',
    ].join('\n');
    expect(() =>
      parseMcpServers(content, { envRoot, allowlistHosts: ['shared.MCP.internal'] }),
    ).toThrow('collides with an allowlist entry');
  });

  it('rejects malformed top-level YAML shapes', () => {
    expect(() => parseMcpServers('name: a\n', { envRoot })).toThrow(
      'must be a top-level list of entries',
    );
  });
});
