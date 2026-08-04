export type PathId =
  'term' | 'pass' | 'http' | 'deny443' | 'cand' | 'mcp' | 'passopen' | 'blocklist';

/** Header names carried by a `cand` line, in field order; also their display names. */
export const CAND_HEADER_NAMES = [
  'Authorization',
  'Cookie',
  'X-API-Key',
  'X-Auth-Token',
  'Proxy-Authorization',
] as const;

export interface AccessLine {
  pathId: PathId;
  time: string;
  serverName: string;
  authority: string;
  codeDetails: string;
  /** Non-`cand` only: the actual HTTP status Envoy returned to the client. */
  responseCode?: string;
  /** Non-`cand` only: Envoy's short failure codes (e.g. `UF`, `UT`), `-` when none apply. */
  responseFlags?: string;
  /** Non-`cand` only: total request duration in milliseconds. */
  duration?: string;
  /** Non-`cand` only: body bytes Envoy sent to the downstream client. */
  bytesSent?: string;
  /** `cand` only: the five truncated header values in CAND_HEADER_NAMES order ('-' when absent). */
  authHeaders?: string[];
  routeName?: string;
}

const PATH_IDS = new Set<PathId>([
  'term',
  'pass',
  'http',
  'deny443',
  'cand',
  'mcp',
  'passopen',
  'blocklist',
]);

export function parseLine(raw: string): AccessLine | null {
  const idx = raw.indexOf('CFGM|');
  if (idx === -1) return null;
  const parts = raw.slice(idx).trim().split('|');
  const pathId = parts[1] as PathId;
  if (!PATH_IDS.has(pathId)) return null;
  const expectedFields = pathId === 'cand' || pathId === 'http' ? 11 : 10;
  if (parts.length !== expectedFields) return null;
  const [, , time, serverName, authority, codeDetails] = parts;
  if (pathId === 'cand') {
    return {
      pathId,
      time,
      serverName,
      authority,
      codeDetails,
      authHeaders: parts.slice(6),
    };
  }
  const [, , , , , , responseCode, responseFlags, duration, bytesSent, routeName] = parts;
  return {
    pathId,
    time,
    serverName,
    authority,
    codeDetails,
    responseCode,
    responseFlags,
    duration,
    bytesSent,
    ...(pathId === 'http' ? { routeName } : {}),
  };
}
