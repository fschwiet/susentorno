# Treat the allowlist as an explicit policy language

The allowlist uses validated `#pragma` sections to distinguish passthrough, provider-specific credential injection, and authentication-candidate observation. It accepts only exact terminated hosts and a single leading-label `*.` wildcard for passthrough, removes redundant entries, and resolves cross-section collisions deterministically with warnings; explicit parsing and priority are preferred to silently producing ambiguous Envoy filter chains.
