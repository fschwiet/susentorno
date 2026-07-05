import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Render the Envoy file-based SDS secret. Structure must match the committed
 * `envoy/secrets/sds-secret.yaml`. This is `scripts/host-session-hook.sh`'s
 * heredoc body ported to TypeScript.
 */
export function formatSecret(token: string): string {
  return [
    'resources:',
    '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
    '    name: sandbox_bearer_token',
    '    generic_secret:',
    '      secret:',
    `        inline_string: "Bearer ${token}"`,
    '',
  ].join('\n');
}

export function writeSecret(token: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, formatSecret(token));
}
