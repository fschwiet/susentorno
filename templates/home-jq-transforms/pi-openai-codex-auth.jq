# "access" must stay byte-identical to CODEX_PLACEHOLDER_ACCESS_TOKEN in
# src/codexPlaceholder.ts (docs/adr/0018) — the proxy's chatgpt.com gate matches this
# exact literal to inject the codex host credential channel's real token. "expires" is
# a far-future epoch-ms so Pi's own client never decides the token needs refreshing.
.["openai-codex"] = {
  "type": "oauth",
  "access": "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJzYW5kYm94LXVzZXIiLCJlbWFpbCI6InNhbmRib3hAY29uZmlnYW1hdHJvbi5pbnZhbGlkIiwiZXhwIjo0MTAyNDQ0ODAwfQ.sandbox-not-a-real-signature",
  "refresh": "sandbox-placeholder-pi-refresh-token",
  "expires": 4102444800000,
  "accountId": "sandbox-placeholder-account-id"
}
