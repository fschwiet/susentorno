import { buildJwt } from './jwt';

/** ~ year 2100 in epoch **seconds** — far past any real session, mirroring Claude's placeholder expiry. */
export const CODEX_PLACEHOLDER_EXP_SECONDS = 4102444800;

/**
 * Placeholder account id, never a real account. Pi Coding Agent's OpenAI-Codex
 * provider decodes this claim on *every* request and sets it as the `chatgpt-account-id`
 * header, throwing "Failed to extract accountId from token" if it's absent — so it must
 * be present for Pi to run at all. The proxy's CODEX_GATE_LUA (src/envoyConfig.ts)
 * strips this header unconditionally whenever it recognizes the placeholder Bearer
 * token, so the real account id (not this value) is what actually reaches OpenAI.
 */
export const CODEX_PLACEHOLDER_ACCOUNT_ID = 'susentorno-placeholder-account-id';

const PLACEHOLDER_CLAIMS = {
  sub: 'susentorno-user',
  email: 'susentorno@susentorno.invalid',
  exp: CODEX_PLACEHOLDER_EXP_SECONDS,
  'https://api.openai.com/auth': { chatgpt_account_id: CODEX_PLACEHOLDER_ACCOUNT_ID },
};

/**
 * Placeholder JWT the VM's Codex CLI carries in ~/.codex/auth.json. Never sent to
 * OpenAI: the proxy's gate matches `Authorization: Bearer <this>` and the
 * credential_injector swaps it for the real token. The far-future `exp` stops the
 * VM's own client from ever deciding it must refresh.
 */
export const CODEX_PLACEHOLDER_ACCESS_TOKEN = buildJwt(PLACEHOLDER_CLAIMS);

/** Codex may decode id_token locally for display without ever transmitting it. */
export const CODEX_PLACEHOLDER_ID_TOKEN = buildJwt(PLACEHOLDER_CLAIMS);

/** Never used: the access token never appears expired, so no refresh is attempted. */
export const CODEX_PLACEHOLDER_REFRESH_TOKEN = 'susentorno-placeholder-codex-refresh-token';
