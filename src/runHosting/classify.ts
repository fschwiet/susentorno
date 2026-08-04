import type { AccessLine, PathId } from './parseLine';
import { CAND_HEADER_NAMES } from './parseLine';

export type Tag =
  | 'ALLOW CRED'
  | 'ALLOW PASS'
  | 'ALLOW HTTP'
  | 'ALLOW MCP'
  | 'ALLOW OPEN'
  | 'BLOCK TLS'
  | 'BLOCK HTTP'
  | 'BLOCK LIST'
  | 'AUTH CANDIDATE';

export interface Entry {
  time: string;
  tag: Tag;
  domain: string;
  port: number;
  protocol?: string;
  header?: string;
  value?: string;
}

const TAG_BY_443_PATH_ID: Partial<Record<PathId, Tag>> = {
  term: 'ALLOW CRED', pass: 'ALLOW PASS', mcp: 'ALLOW MCP', deny443: 'BLOCK TLS', passopen: 'ALLOW OPEN', blocklist: 'BLOCK LIST',
};
const TAG_BY_HTTP_ROUTE_NAME: Record<string, Tag> = {
  matched: 'ALLOW HTTP', blocked: 'BLOCK LIST', 'default-deny': 'BLOCK HTTP', open: 'ALLOW OPEN',
};

function stripPort(host: string): string {
  const idx = host.lastIndexOf(':');
  return idx === -1 ? host : host.slice(0, idx);
}

export function classify(line: AccessLine): Entry[] {
  const domain = stripPort(line.serverName !== '-' ? line.serverName : line.authority);

  if (line.pathId === 'cand') {
    const values = line.authHeaders ?? [];
    const entries: Entry[] = [];
    CAND_HEADER_NAMES.forEach((header, i) => {
      const value = values[i];
      if (value === undefined || value === '-') return;
      // protocol is hardcoded 'https' since auth-candidate only supports :443.
      entries.push({
        time: line.time,
        tag: 'AUTH CANDIDATE',
        domain,
        port: 443,
        protocol: 'https',
        header,
        value,
      });
    });
    return entries;
  }

  if (line.pathId === 'http') {
    const tag = TAG_BY_HTTP_ROUTE_NAME[line.routeName ?? ''];
    return tag ? [{ time: line.time, tag, domain, port: 80 }] : [];
  }
  const tag = TAG_BY_443_PATH_ID[line.pathId];
  return tag ? [{ time: line.time, tag, domain, port: 443 }] : [];
}
