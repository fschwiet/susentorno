/**
 * Redaction of secrets (passwords, usernames, scripts) from text that may be
 * shown to the user. A secret is not only ever spelled as it was typed: the
 * request that carried it is JSON, and a guest tool that echoes or re-serializes
 * it can spell it JSON-escaped, with non-ASCII as \uXXXX, with PowerShell's
 * ConvertTo-Json apostrophe escapes, single-quote-doubled, or base64.
 */

const REDACTED = '[redacted]';

const hex4 = (unit: string, upper: boolean): string => {
  const hex = unit.charCodeAt(0).toString(16).padStart(4, '0');
  return upper ? hex.toUpperCase() : hex;
};

/** Every distinct spelling of `secret` that must never survive in a message, longest first. */
export function secretSpellings(secret: string): string[] {
  if (secret.length === 0) return [];
  const jsonInner = JSON.stringify(secret).slice(1, -1);
  const escapeUnits = (text: string, pattern: RegExp, upper: boolean): string =>
    text.replace(pattern, (unit) => `\\u${hex4(unit, upper)}`);
  const spellings = new Set<string>([
    secret,
    jsonInner,
    // The request as the executor serializes it, and the same with uppercase hex.
    escapeUnits(jsonInner, /[\u007f-￿]/g, false),
    escapeUnits(jsonInner, /[\u007f-￿]/g, true),
    // Windows PowerShell's ConvertTo-Json escapes ' < > & as \u00XX.
    escapeUnits(jsonInner, /['<>&]/g, false),
    escapeUnits(escapeUnits(jsonInner, /[\u007f-￿]/g, false), /['<>&]/g, false),
    // Every UTF-16 unit as \uXXXX.
    escapeUnits(secret, /[\s\S]/g, false),
    escapeUnits(secret, /[\s\S]/g, true),
    // A PowerShell single-quoted literal.
    secret.replace(/'/g, "''"),
    Buffer.from(secret, 'utf8').toString('base64'),
  ]);
  return [...spellings].sort((a, b) => b.length - a.length);
}

/**
 * Replaces every spelling of every secret. Longer spellings go first so a
 * spelling that contains another is removed whole, never left as a fragment.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  const needles = [...new Set(secrets.flatMap(secretSpellings))].sort((a, b) => b.length - a.length);
  return needles.reduce((redacted, needle) => redacted.split(needle).join(REDACTED), text);
}
