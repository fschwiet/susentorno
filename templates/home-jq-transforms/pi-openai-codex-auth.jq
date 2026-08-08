# "access" must stay byte-identical to CODEX_PLACEHOLDER_ACCESS_TOKEN in
# src/codexPlaceholder.ts (docs/adr/0018) — the proxy's chatgpt.com gate matches this
# exact literal to inject the codex host credential channel's real token and real
# account id. "expires" is a far-future epoch-ms so Pi's own client never decides the
# token needs refreshing. tests/unit/templates.test.ts asserts this stays in sync.
.["openai-codex"] = {
  "type": "oauth",
  "access": "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJzdXNlbnRvcm5vLXVzZXIiLCJlbWFpbCI6InN1c2VudG9ybm9Ac3VzZW50b3Juby5pbnZhbGlkIiwiZXhwIjo0MTAyNDQ0ODAwLCJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoic3VzZW50b3Juby1wbGFjZWhvbGRlci1hY2NvdW50LWlkIn19.susentorno-not-a-real-signature",
  "refresh": "susentorno-placeholder-pi-refresh-token",
  "expires": 4102444800000,
  "accountId": "susentorno-placeholder-account-id"
}
