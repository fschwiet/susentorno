import type { AccessLine } from './parseLine';

export type Tag = 'ALLOW CRED' | 'ALLOW PASS' | 'ALLOW HTTP' | 'BLOCK TLS' | 'BLOCK HTTP';

export interface Entry {
  time: string;
  tag: Tag;
  domain: string;
}

export function classify(line: AccessLine): Entry {
  const domain = line.serverName !== '-' ? line.serverName : line.authority;
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
  return { time: line.time, tag, domain };
}
