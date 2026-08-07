/**
 * PowerShell single-quote a value for interpolation into a `-Command` script
 * string. Every embedded `'` becomes `''` — PowerShell's own escaping rule
 * for single-quoted strings (distinct from POSIX's `'\\''`, which is what
 * quoteForRemoteShell uses for the SSH/guest-shell side).
 */
export function quoteForPowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
