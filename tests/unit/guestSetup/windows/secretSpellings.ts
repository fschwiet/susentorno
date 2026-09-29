/**
 * Every way a secret can be spelled when the request that carried it, or a tool
 * that re-serialized it, is echoed back in an error message. Deliberately written
 * independently of the production redaction so the tests do not share its bugs.
 */

/** Characters JSON escapes (quote, backslash, tab), that PowerShell's ConvertTo-Json escapes
 * as '-style (apostrophe, angle brackets, ampersand), and non-ASCII (BMP and astral). */
export const NASTY_PASSWORD = 'p"a\\ss\tw\'<o&r>d-☃-\u{1F600}';
export const NASTY_USERNAME = 'Ädmin"one';
export const NASTY_SCRIPT = 'Write-Output "It\'s \\ a \t sc"r<ipt> ☃"';

const hex4 = (char: string, upper: boolean): string => {
  const hex = char.charCodeAt(0).toString(16).padStart(4, '0');
  return upper ? hex.toUpperCase() : hex;
};

export function secretSpellings(secret: string): Record<string, string> {
  const jsonInner = JSON.stringify(secret).slice(1, -1);
  const everyCharacter = (upper: boolean): string =>
    [...secret]
      .flatMap((char) => (char.length === 1 ? [char] : [char[0], char[1]]))
      .map((unit) => `\\u${hex4(unit, upper)}`)
      .join('');
  const nonAsciiEscaped = (upper: boolean): string =>
    jsonInner.replace(/[\u007f-\uffff]/g, (unit) => `\\u${hex4(unit, upper)}`);
  const powershellJson = jsonInner.replace(/['<>&]/g, (char) => `\\u${hex4(char, false)}`);
  return {
    'JSON-escaped': jsonInner,
    'JSON-escaped with non-ASCII as \\uxxxx': nonAsciiEscaped(false),
    'JSON-escaped with non-ASCII as \\uXXXX': nonAsciiEscaped(true),
    'ConvertTo-Json apostrophe form': powershellJson,
    'every character as \\uxxxx': everyCharacter(false),
    'every character as \\uXXXX': everyCharacter(true),
    'PowerShell single-quoted': secret.replace(/'/g, "''"),
    base64: Buffer.from(secret, 'utf8').toString('base64'),
  };
}
