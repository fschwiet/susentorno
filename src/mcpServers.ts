import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';

export interface McpServerConfig {
  name: string;
  hostname: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

const NAME_RE = /^[a-zA-Z0-9_-]+$/;
const HOSTNAME_RE =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

function validateServer(raw: unknown, index: number): McpServerConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`mcp-servers.yaml: servers[${index}] must be a mapping`);
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.name !== 'string' || !NAME_RE.test(r.name)) {
    throw new Error(
      `mcp-servers.yaml: servers[${index}].name must match ${NAME_RE} (got ${JSON.stringify(r.name)})`,
    );
  }
  if (typeof r.hostname !== 'string' || !HOSTNAME_RE.test(r.hostname)) {
    throw new Error(
      `mcp-servers.yaml: servers[${index}].hostname must be a valid hostname (got ${JSON.stringify(r.hostname)})`,
    );
  }
  if (typeof r.command !== 'string' || r.command.trim() === '') {
    throw new Error(`mcp-servers.yaml: servers[${index}].command is required`);
  }
  if (r.cwd !== undefined && typeof r.cwd !== 'string') {
    throw new Error(`mcp-servers.yaml: servers[${index}].cwd must be a string`);
  }
  if (r.env !== undefined) {
    if (typeof r.env !== 'object' || r.env === null || Array.isArray(r.env)) {
      throw new Error(`mcp-servers.yaml: servers[${index}].env must be a mapping of strings`);
    }
    for (const [key, value] of Object.entries(r.env as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        throw new Error(`mcp-servers.yaml: servers[${index}].env.${key} must be a string`);
      }
    }
  }

  return {
    name: r.name,
    hostname: r.hostname,
    command: r.command,
    cwd: r.cwd as string | undefined,
    env: r.env as Record<string, string> | undefined,
  };
}

export function parseMcpServers(content: string): McpServerConfig[] {
  let doc: unknown;
  try {
    doc = parse(content);
  } catch (err) {
    throw new Error(`mcp-servers.yaml is not valid YAML: ${String(err)}`);
  }
  if (typeof doc !== 'object' || doc === null || !Array.isArray((doc as Record<string, unknown>).servers)) {
    throw new Error("mcp-servers.yaml must have a top-level 'servers' list");
  }

  const servers = (doc as { servers: unknown[] }).servers.map(validateServer);

  const names = new Set<string>();
  const hostnames = new Set<string>();
  for (const server of servers) {
    if (names.has(server.name)) {
      throw new Error(`mcp-servers.yaml: duplicate server name '${server.name}'`);
    }
    names.add(server.name);
    if (hostnames.has(server.hostname)) {
      throw new Error(`mcp-servers.yaml: duplicate server hostname '${server.hostname}'`);
    }
    hostnames.add(server.hostname);
  }

  return servers;
}

/** Returns [] if `path` doesn't exist. Throws on any read, parse, or validation failure. */
export function readMcpServers(path: string): McpServerConfig[] {
  if (!existsSync(path)) return [];
  return parseMcpServers(readFileSync(path, 'utf8'));
}
