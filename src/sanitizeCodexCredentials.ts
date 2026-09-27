import {
  CODEX_PLACEHOLDER_ACCESS_TOKEN,
  CODEX_PLACEHOLDER_ID_TOKEN,
  CODEX_PLACEHOLDER_REFRESH_TOKEN,
} from './codexPlaceholder';

/**
 * Turn a real ~/.codex/auth.json into the VM placeholder copy: the three token fields
 * under `tokens` become placeholder credentials (access/id are far-future placeholder
 * JWTs so the VM's Codex never tries to refresh; refresh_token is a fixed dummy).
 * `tokens.account_id` passes through unchanged: Codex >=0.156 checks it against the
 * workspaces returned by routing discovery (`wham/accounts/check`) and refuses to start
 * on a mismatch. It is an identifier, not a credential, and the proxy still replaces
 * the guest's chatgpt-account-id header with the host's current id (see ADR 0002).
 * Everything else — auth_mode, OPENAI_API_KEY — passes through so the file matches the
 * user's real account shape. Output is pretty-printed JSON, LF line endings only.
 */
export function sanitizeCodexCredentials(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('codex auth file is not valid JSON');
  }

  // Scope + safety guard: only ChatGPT-plan sign-in is supported. In api_key mode the
  // real OPENAI_API_KEY is a live secret that pass-through would leak into the VM share,
  // so refuse rather than sanitize it.
  if ((parsed as { auth_mode?: unknown } | null)?.auth_mode !== 'chatgpt') {
    throw new Error('codex auth file is not chatgpt-mode (auth_mode must be "chatgpt")');
  }

  const tokens = (parsed as { tokens?: unknown } | null)?.tokens;
  if (!tokens || typeof tokens !== 'object') {
    throw new Error('codex auth file has no tokens object');
  }

  const record = tokens as Record<string, unknown>;
  record.access_token = CODEX_PLACEHOLDER_ACCESS_TOKEN;
  record.id_token = CODEX_PLACEHOLDER_ID_TOKEN;
  record.refresh_token = CODEX_PLACEHOLDER_REFRESH_TOKEN;

  return JSON.stringify(parsed, null, 2) + '\n';
}
