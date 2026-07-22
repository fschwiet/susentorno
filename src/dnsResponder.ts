/**
 * Reject dns-responder build artifacts (bin/obj) so a developer's local build output
 * never gets copied onto the read-only VM share.
 */
export function isDnsResponderBuildArtifact(source: string): boolean {
  const segments = source.split(/[\\/]/);
  const dnsIdx = segments.indexOf('dns-responder');
  if (dnsIdx === -1) return false;
  return segments.slice(dnsIdx + 1).some((segment) => segment === 'bin' || segment === 'obj');
}
