export type PathId = 'term' | 'pass' | 'http' | 'deny443';

export interface AccessLine {
  pathId: PathId;
  time: string;
  serverName: string;
  authority: string;
  codeDetails: string;
}

const PATH_IDS = new Set<PathId>(['term', 'pass', 'http', 'deny443']);

export function parseLine(raw: string): AccessLine | null {
  const idx = raw.indexOf('CFGM|');
  if (idx === -1) return null;
  const parts = raw.slice(idx).trim().split('|');
  if (parts.length !== 6) return null;
  const [, pathId, time, serverName, authority, codeDetails] = parts;
  if (!PATH_IDS.has(pathId as PathId)) return null;
  return {
    pathId: pathId as PathId,
    time,
    serverName,
    authority,
    codeDetails,
  };
}
