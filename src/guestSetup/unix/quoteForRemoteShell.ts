/**
 * POSIX single-quote a value for interpolation into a remote shell command
 * string. Every embedded `'` becomes `'\''` (close quote, escaped literal
 * quote, reopen quote) — the standard way to safely nest an arbitrary string
 * inside single quotes in sh/bash.
 */
export function quoteForRemoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
