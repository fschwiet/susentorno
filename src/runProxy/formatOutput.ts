import type { Entry } from './classify';

function hms(iso: string): string {
  return iso.slice(11, 19);
}

export function formatOutput(entry: Entry): string {
  if (entry.tag === 'AUTH CANDIDATE') {
    return `${hms(entry.time)}  AUTH CANDIDATE  ${entry.domain}  ${entry.protocol}  ${entry.header}=${entry.value}`;
  }
  return `${hms(entry.time)}  ${entry.tag}  ${entry.domain}`;
}
