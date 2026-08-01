import { buildJwt } from './jwt';

/** ~ year 2100 in epoch **seconds** — far past any real session, mirroring Claude's placeholder expiry. */
export const CODEX_PLACEHOLDER_EXP_SECONDS = 4102444800;

const PLACEHOLDER_CLAIMS = {
  sub: 'susentorno-user',
  email: 'susentorno@susentorno.invalid',
  exp: CODEX_PLACEHOLDER_EXP_SECONDS,
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
