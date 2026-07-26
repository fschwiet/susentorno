# Terms to resolve

Vocabulary tensions surfaced while importing the design specs. This is a hit-list for a later `/domain-modeling` pass, **not** a glossary — the resolving (and any code renames) belongs to that skill, not this import.

- **"allow list" vs "allowlist" vs "allow-list".** All three spellings appear across specs, docs, and code (`current-allow-list.txt`, `parseAllowlist`, `proxy/allowlist.txt`, prose "allow list"). Pick one canonical form.
- **"terminate" vs "claude authenticated" vs "authenticated".** The on-disk pragma was renamed `# terminate` → `#pragma claude authenticated`, but the in-memory field is still `terminate`/`claudeAuthenticated`, and `terminateTlsHosts` spans terminate + authCandidate. "Terminate" now means two things (TLS termination as a mechanism vs. the credential-injected section). Also `github`/`codex authenticated` sections now exist. Needs one clear vocabulary for "TLS-terminated" vs "credential-injected" vs "the section name".
- **"passthrough".** Used for `:443` SNI passthrough (no decrypt) — but the credential *gate* is now also described as "pass-through" (forward the header unmodified). Two unrelated meanings of the same word in the same subsystem.
- **"gate".** Historically a fail-closed rejecter (403 on non-placeholder); now a pass-through inject-decision that is explicitly *not* a security boundary. The name still says "gate". Decide whether to keep it.
- **"host IP".** Ambiguous since one-adapter-at-a-time setup: `<default-switch-host-ip>` (temporary NAT) vs `<internal-switch-host-ip>` (stable). The docs already started disambiguating; the term should be pinned project-wide.
- **"environment".** Means a `.configamatron` folder / per-directory deployment. Distinct from "VM"/"guest" and from "the isolated network". Worth an explicit definition.
- **"vm-shared" vs "share" vs "the guest kit".** `vm-shared/` and `vm-shared-windows/` are the copied-in guest folders; specs also call them "shares", "provisioning kit". SMB "share" is a third, related sense.
- **"host-only" (legacy VMware term).** Purged from living files in favor of "Internal switch" / "gateway-less" / "isolated", but still pervasive in the historical specs; make sure the canonical term is "Internal-switch / isolated" going forward.
- **"placeholder credential" vs "sanitized credential" vs "sandbox credential".** All used for the fake per-provider credential seeded into the guest.
- **"nudge" / "refresh".** The proactive `claude -p` / `codex exec` call to keep the host token fresh — an invented term worth defining vs. actual OAuth "refresh".
