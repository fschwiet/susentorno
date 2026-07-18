export type PathId = 'term' | 'pass' | 'http' | 'deny443' | 'cand';

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
  /** `cand` only: the five truncated header values in CAND_HEADER_NAMES order ('-' when absent). */
  authHeaders?: string[];
}

const PATH_IDS = new Set<PathId>(['term', 'pass', 'http', 'deny443', 'cand']);

export function parseLine(raw: string): AccessLine | null {
  const idx = raw.indexOf('CFGM|');
  if (idx === -1) return null;
  const parts = raw.slice(idx).trim().split('|');
  const pathId = parts[1] as PathId;
  if (!PATH_IDS.has(pathId)) return null;
  const expectedFields = pathId === 'cand' ? 11 : 6;
  if (parts.length !== expectedFields) return null;
  const [, , time, serverName, authority, codeDetails] = parts;
  return {
    pathId,
    time,
    serverName,
    authority,
    codeDetails,
    ...(pathId === 'cand' ? { authHeaders: parts.slice(6) } : {}),
  };
}
