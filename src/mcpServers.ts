import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parse } from 'yaml';

export interface McpServer {
  name: string;
  url: string;
  /** Canonicalized (lowercased) host component of `url`; drives SNI, SAN, and collision checks. */
  host: string;
  command: string;
  /** Resolved absolute path, if `workingDir` was set. */
  workingDir?: string;
}

const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;

function validateUrl(url: unknown, label: string): { url: string; host: string } {
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error(`${label}: 'url' is required`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label}: 'url' is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${label}: 'url' must be https: ${url}`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(`${label}: 'url' must not contain userinfo: ${url}`);
  }
  if (parsed.hash !== '') {
    throw new Error(`${label}: 'url' must not contain a fragment: ${url}`);
  }
  if (parsed.port !== '') {
    throw new Error(
      `${label}: 'url' must use the default port or explicit 443, not ${parsed.port}: ${url}`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (IPV4_PATTERN.test(host) || host.startsWith('[')) {
    throw new Error(`${label}: 'url' host must be a hostname, not an IP literal: ${url}`);
  }
  return { url, host };
}

function validateCommand(command: unknown, label: string): string {
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error(`${label}: 'command' is required`);
  }
  if (!command.includes('{ip}') || !command.includes('{port}')) {
    throw new Error(
      `${label}: 'command' must contain both {ip} and {port} placeholders: ${command}`,
    );
  }
  return command;
}

function validateWorkingDir(
  workingDir: unknown,
  label: string,
  envRoot: string,
): string | undefined {
  if (workingDir === undefined) return undefined;
  if (typeof workingDir !== 'string' || workingDir.length === 0) {
    throw new Error(`${label}: 'workingDir' must be a non-empty string`);
  }
  const resolved = isAbsolute(workingDir) ? workingDir : join(envRoot, workingDir);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(
      `${label}: 'workingDir' does not resolve to an existing directory: ${workingDir}`,
    );
  }
  return resolved;
}

function validateName(name: unknown, label: string): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`${label}: 'name' is required`);
  }
  return name;
}

function validateRecord(entry: unknown, index: number, envRoot: string): McpServer {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`mcp-servers.yaml: entry ${index} must be a mapping`);
  }
  const e = entry as Record<string, unknown>;
  const label = `mcp-servers.yaml: entry ${index}`;
  const name = validateName(e.name, label);
  const { url, host } = validateUrl(e.url, `${label} ('${name}')`);
  const command = validateCommand(e.command, `${label} ('${name}')`);
  const workingDir = validateWorkingDir(e.workingDir, `${label} ('${name}')`, envRoot);
  return { name, url, host, command, workingDir };
}

export function parseMcpServers(
  content: string,
  opts: { envRoot: string; allowlistHosts?: string[] },
): McpServer[] {
  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch (error) {
    throw new Error(`mcp-servers.yaml is not valid YAML: ${(error as Error).message}`, {
      cause: error,
    });
  }
  if (parsed === null || parsed === undefined) return [];
  if (!Array.isArray(parsed)) {
    throw new Error('mcp-servers.yaml must be a top-level list of entries');
  }

  const records = parsed.map((entry, i) => validateRecord(entry, i, opts.envRoot));

  const seenNames = new Set<string>();
  for (const record of records) {
    if (seenNames.has(record.name)) {
      throw new Error(`mcp-servers.yaml: duplicate name '${record.name}'`);
    }
    seenNames.add(record.name);
  }

  const seenHosts = new Set<string>();
  for (const record of records) {
    if (seenHosts.has(record.host)) {
      throw new Error(
        `mcp-servers.yaml: duplicate hostname '${record.host}' (entry '${record.name}')`,
      );
    }
    seenHosts.add(record.host);
  }

  const allowlistHosts = new Set((opts.allowlistHosts ?? []).map((h) => h.toLowerCase()));
  for (const record of records) {
    if (allowlistHosts.has(record.host)) {
      throw new Error(
        `mcp-servers.yaml: hostname '${record.host}' (entry '${record.name}') collides with an allowlist entry`,
      );
    }
  }

  return records;
}
