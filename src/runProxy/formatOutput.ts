import type { Entry } from './classify';

function hms(iso: string): string {
  return iso.slice(11, 19);
}

export function formatOutput(entry: Entry): string {
  return `${hms(entry.time)}  ${entry.tag}  ${entry.domain}`;
}
