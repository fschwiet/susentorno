/**
 * The single fixed placeholder PAT the VM's git/gh sends on the wire to both
 * github.com and api.github.com. The proxy's gates check for exactly this value
 * and the credential_injector swaps it for the real credential. It is never a
 * real token, so it is safe to ship into the VM share.
 */
export const GITHUB_PLACEHOLDER_PAT = 'ghp-susentorno-PLACEHOLDER';
