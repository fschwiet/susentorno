import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Render an Envoy file-based SDS secret carrying a single `Bearer <token>` generic
 * secret under `resourceName`. Each Envoy SDS subscription watches its own
 * single-resource file, so the resource name is chosen by the caller (Claude uses
 * `sandbox_bearer_token`, Codex uses `codex_bearer_token`).
 */
export function formatSecret(token: string, resourceName: string): string {
  return [
    'resources:',
    '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
    `    name: ${resourceName}`,
    '    generic_secret:',
    '      secret:',
    `        inline_string: "Bearer ${token}"`,
    '',
  ].join('\n');
}

export function writeSecret(token: string, path: string, resourceName: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, formatSecret(token, resourceName));
}
