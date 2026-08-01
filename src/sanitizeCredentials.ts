/**
 * Placeholder values written into the VM's credentials file. The accessToken value
 * must match exactly what the proxy's gate.lua swaps for the real token.
 */
export const PLACEHOLDER_ACCESS_TOKEN = 'sk-ant-oat-CONFIGAMATRON-PLACEHOLDER';
export const PLACEHOLDER_REFRESH_TOKEN = 'configamatron-placeholder-refresh-token';
export const PLACEHOLDER_EXPIRES_AT = 4102444800000;

/**
 * Turn a real host credentials file into the VM placeholder copy: tokens and expiry
 * become placeholders, every other field passes through so the file matches the
 * user's real account shape. Output is pretty-printed JSON, LF line endings only.
 */
export function sanitizeCredentials(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('credentials file is not valid JSON');
  }

  const oauth = (parsed as { claudeAiOauth?: unknown } | null)?.claudeAiOauth;
  if (!oauth || typeof oauth !== 'object') {
    throw new Error('credentials file has no claudeAiOauth object');
  }

  const record = oauth as Record<string, unknown>;
  record.accessToken = PLACEHOLDER_ACCESS_TOKEN;
  record.refreshToken = PLACEHOLDER_REFRESH_TOKEN;
  record.expiresAt = PLACEHOLDER_EXPIRES_AT;

  return JSON.stringify(parsed, null, 2) + '\n';
}
