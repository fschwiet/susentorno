import type { Entry } from './classify';

function hms(iso: string): string {
  return iso.slice(11, 19);
}

export function formatOutput(entry: Entry): string {
  if (entry.tag === 'AUTH CANDIDATE') {
    return `${hms(entry.time)}  AUTH CANDIDATE  ${entry.domain}:${entry.port}  ${entry.protocol}  ${entry.header}=${entry.value}`;
  }
  if (entry.tag === 'AUTH REJECTED') {
    return `${hms(entry.time)}  AUTH REJECTED  ${entry.domain}:${entry.port}  upstream returned 401`;
  }
  return `${hms(entry.time)}  ${entry.tag}  ${entry.domain}:${entry.port}`;
}
