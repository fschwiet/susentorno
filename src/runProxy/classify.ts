import type { AccessLine } from './parseLine';
import { CAND_HEADER_NAMES } from './parseLine';

export type Tag =
  | 'ALLOW CRED'
  | 'ALLOW PASS'
  | 'ALLOW HTTP'
  | 'BLOCK TLS'
  | 'BLOCK HTTP'
  | 'AUTH CANDIDATE';

export interface Entry {
  time: string;
  tag: Tag;
  domain: string;
  protocol?: string;
  header?: string;
  value?: string;
}

export function classify(line: AccessLine): Entry[] {
  const domain = line.serverName !== '-' ? line.serverName : line.authority;

  if (line.pathId === 'cand') {
    const values = line.authHeaders ?? [];
    const entries: Entry[] = [];
    CAND_HEADER_NAMES.forEach((header, i) => {
      const value = values[i];
      if (value === undefined || value === '-') return;
      // protocol is hardcoded 'https' since auth-candidate only supports :443.
      entries.push({ time: line.time, tag: 'AUTH CANDIDATE', domain, protocol: 'https', header, value });
    });
    return entries;
  }

  let tag: Tag;
  switch (line.pathId) {
    case 'term':
      tag = 'ALLOW CRED';
      break;
    case 'pass':
      tag = 'ALLOW PASS';
      break;
    case 'deny443':
      tag = 'BLOCK TLS';
      break;
    case 'http':
      tag = line.codeDetails === 'direct_response' ? 'BLOCK HTTP' : 'ALLOW HTTP';
      break;
  }
  return [{ time: line.time, tag, domain }];
}
