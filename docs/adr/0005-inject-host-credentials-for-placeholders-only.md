# Keep real agent credentials on the host and inject only for placeholders

Guests receive non-secret placeholder credentials for Claude, GitHub, and Codex; on selected TLS-terminated hosts, Envoy replaces a recognized placeholder with a host-side credential delivered through file-backed SDS. Missing credentials and non-placeholder credentials pass upstream unchanged, while secrets stay out of generated Envoy configuration, so legitimate user-supplied authentication still works without allowing the proxy to overwrite it or requiring usable long-lived secrets inside the VM.
