import type { OutputLine } from './reducer';

function hms(iso: string): string {
  return iso.slice(11, 19);
}

export function formatOutput(line: OutputLine): string {
  const base = `${hms(line.time)}  ${line.tag}  ${line.domain}`;
  if (line.count !== undefined && line.since !== undefined) {
    return `${base}  (x${line.count} since ${hms(line.since)})`;
  }
  return base;
}
