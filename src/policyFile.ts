import type { Allowlist } from './allowlist';

const TERMINATE_HOSTS = new Set([
  'api.anthropic.com',
  'claude.com',
  'platform.claude.com',
  'statsig.anthropic.com',
  'mcp-proxy.anthropic.com',
  'downloads.claude.ai',
]);

export function parsePolicyFile(content: string): Allowlist {
  const passthrough = new Set<string>();
  const terminate = new Set<string>();
  let currentType: string | null = null;
  let currentDecision: string | null = null;

  const addResource = (resource: string | undefined): void => {
    if (!resource) return;
    if (currentType !== 'network' || currentDecision !== 'allow') return;
    const host = resource.split(':')[0];
    if (TERMINATE_HOSTS.has(host)) terminate.add(resource);
    else passthrough.add(resource);
  };

  for (const rawLine of content.split(/\r?\n/)) {
    if (rawLine.trim() === '') continue;
    const isContinuation = /^\s/.test(rawLine);
    if (!isContinuation) {
      const fields = rawLine.trim().split(/\s{2,}/);
      if (fields[0] === 'PROVENANCE') continue;
      const [, , , type, decision, firstResource] = fields;
      currentType = type ?? null;
      currentDecision = decision ?? null;
      addResource(firstResource);
    } else {
      addResource(rawLine.trim());
    }
  }

  return {
    passthrough: [...passthrough].sort(),
    terminate: [...terminate].sort(),
  };
}
