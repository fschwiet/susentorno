# Enforce VM egress with a selective Envoy interception proxy

Configamatron forces guest HTTP and HTTPS traffic through host-side Envoy instead of relying on application proxy settings. Envoy rejects destinations outside an allowlist, passes ordinary allowed TLS through without decryption, and terminates TLS only where HTTP-layer behavior such as credential injection or authentication diagnostics requires it; this preserves end-to-end TLS for most traffic while making the security boundary independent of whether guest applications cooperate.
