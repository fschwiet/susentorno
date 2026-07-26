# Keep a durable root CA and derive short-lived allowlist leaves

Each environment creates and trusts a durable root CA once, while `run-proxy` derives and reissues the Envoy leaf certificate when the set of TLS-terminated allowlist hosts changes. Keeping the trust anchor stable avoids repeatedly modifying guest trust stores, and deriving SAN-scoped leaves avoids serving the broadly capable root certificate and key directly from Envoy.
