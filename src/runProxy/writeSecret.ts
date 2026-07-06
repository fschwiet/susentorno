import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Render the Envoy file-based SDS secret consumed from
 * .configamatron/proxy/secrets/sds-secret.yaml.
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
