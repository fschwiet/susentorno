const VETHERNET_ALIAS_RE = /^vEthernet \((.+)\)$/;

/**
 * Derives a Hyper-V switch name from its host-side adapter alias: Windows
 * names that adapter `vEthernet (<switch name>)` by construction. Returns
 * null when the alias doesn't have that shape, so the caller can surface a
 * clear pre-flight error rather than deriving a nonsense switch name.
 */
export function deriveSwitchName(adapterAlias: string): string | null {
  const match = VETHERNET_ALIAS_RE.exec(adapterAlias);
  return match ? match[1] : null;
}
