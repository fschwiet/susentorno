import type { Allowlist } from './allowlist';
import { WILDCARD_HOST_PATTERN } from './allowlist';

const TERMINATE_HOSTS = new Set([
  'api.anthropic.com',
  'claude.com',
  'platform.claude.com',
  'statsig.anthropic.com',
  'mcp-proxy.anthropic.com',
  'downloads.claude.ai',
]);

function normalizeWildcardHost(host: string): string {
  return host.startsWith('**.') ? `*.${host.slice(3)}` : host;
}

export function parsePolicyFile(content: string): Allowlist {
  const passthrough = new Set<string>();
  const terminate = new Set<string>();
  const warnings = new Set<string>();
  let currentType: string | null = null;
  let currentDecision: string | null = null;

  const addResource = (resource: string | undefined): void => {
    if (!resource) return;
    if (currentType !== 'network' || currentDecision !== 'allow') return;
    const host = resource.split(':')[0];
    if (host.includes('*')) {
      const normalizedHost = normalizeWildcardHost(host);
      if (!WILDCARD_HOST_PATTERN.test(normalizedHost)) {
        warnings.add(`unsupported wildcard syntax, excluded: '${resource}'`);
        return;
      }
      passthrough.add(`${normalizedHost}${resource.slice(host.length)}`);
      return;
    }
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
    claudeAuthenticated: [...terminate].sort(),
    githubAuthenticated: [],
    authCandidate: [],
    warnings: [...warnings].sort(),
  };
}
