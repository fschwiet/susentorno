import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Render an Envoy file-based SDS secret carrying `value` verbatim as a `generic_secret`
 * under `resourceName`. The pinned Envoy image requires this exact quoted shape.
 */
export function formatPlainSecret(value: string, resourceName: string): string {
  return [
    'resources:',
    '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
    `    name: ${resourceName}`,
    '    generic_secret:',
    '      secret:',
    `        inline_string: "${value}"`,
    '',
  ].join('\n');
}

export function formatSecret(token: string, resourceName: string): string {
  return formatPlainSecret(`Bearer ${token}`, resourceName);
}

export function writePlainSecret(value: string, path: string, resourceName: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, formatPlainSecret(value, resourceName));
}

export function writeSecret(token: string, path: string, resourceName: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, formatSecret(token, resourceName));
}
