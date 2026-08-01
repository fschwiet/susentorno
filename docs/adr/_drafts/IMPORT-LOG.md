# ADR import log

Source folders (considered first to last by date):
- docs/superpowers/specs
- docs/honist-v/specs
- docs/superpowers/plans
- docs/honist-v/plans

Supporting evidence considered after the plans:
- docs/investigations

Additional source document (ingested after the folders, on request):
- technical-notes.md (maintainer notes; kept in place — decisions imported, file retained)

Status is `pending` or `reviewed`. All rows reviewed. "Drafts produced" lists the
draft slug(s) a document fed; `—` means the document produced no standalone draft
(a bug/robustness/testing/doc fix, or a decision that was later overtaken and is
recorded only as history inside another draft).

| Source document | Status | Drafts produced |
| --- | --- | --- |
| docs/superpowers/specs/2026-07-01-envoy-sandbox-proxy-design.md | reviewed | egress-through-host-envoy-proxy, credential-injection-at-proxy, transparent-interception-and-network-isolation-boundary, no-oauth-refresh-piggyback-host-cli |
| docs/superpowers/specs/2026-07-03-vm-github-auth-design.md | reviewed | — (superseded by github-credential-injection 07-19; PAT provisioning folded into credential-injection-at-proxy) |
| docs/superpowers/specs/2026-07-04-vm-dns-netplan-merge-and-iptables-path-design.md | reviewed | — (obsolete: in-guest DNS/iptables deleted; history in host-side-dns-and-dhcp) |
| docs/superpowers/specs/2026-07-04-vm-dns-stub-design.md | reviewed | — (obsolete: in-guest DNS deleted; history in host-side-dns-and-dhcp) |
| docs/superpowers/specs/2026-07-04-vm-dns-stub-dnsmasq-design.md | reviewed | — (obsolete: in-guest dnsmasq deleted; history in host-side-dns-and-dhcp) |
| docs/superpowers/specs/2026-07-05-susentorno-environments-design.md | reviewed | per-directory-environment-model |
| docs/superpowers/specs/2026-07-05-run-proxy-credential-monitor-design.md | reviewed | run-proxy-owns-proxy-lifecycle, no-oauth-refresh-piggyback-host-cli |
| docs/superpowers/specs/2026-07-05-vm-host-only-default-route-design.md | reviewed | — (obsolete: in-guest default-route hack deleted; rejected-alternative history in host-side-dns-and-dhcp) |
| docs/superpowers/specs/2026-07-06-proxy-logging-design.md | reviewed | envoy-access-log-contract |
| docs/superpowers/specs/2026-07-06-vm-e2e-test-harness-design.md | reviewed | vm-tests-via-qemu-in-wsl2 |
| docs/superpowers/specs/2026-07-07-allowlist-dedup-design.md | reviewed | allowlist-format-and-parse-trust-boundary |
| docs/superpowers/specs/2026-07-07-verify-scripts-design.md | reviewed | — (operator diagnostic feature, fails the ADR gate) |
| docs/superpowers/specs/2026-07-08-envoy-http80-wildcard-design.md | reviewed | allowlist-format-and-parse-trust-boundary |
| docs/superpowers/specs/2026-07-09-proxy-ca-leaf-split-design.md | reviewed | root-ca-plus-derived-leaf |
| docs/superpowers/specs/2026-07-09-vm-dhcp-dns-suppression-design.md | reviewed | — (obsolete: in-guest DNS fix; layer deleted) |
| docs/superpowers/specs/2026-07-09-vm-egress-host-forwarder-design.md | reviewed | loopback-publish-with-node-forwarder |
| docs/superpowers/specs/2026-07-10-susentorno-egress-service-idempotent-design.md | reviewed | — (obsolete: in-guest egress unit deleted) |
| docs/superpowers/specs/2026-07-10-run-proxy-merge-config-and-logging-design.md | reviewed | run-proxy-owns-proxy-lifecycle |
| docs/superpowers/specs/2026-07-10-single-star-wildcard-design.md | reviewed | allowlist-format-and-parse-trust-boundary |
| docs/superpowers/specs/2026-07-10-vm-claude-config-script-design.md | reviewed | — (feature/impl; far-future placeholder expiry recorded in credential-injection-at-proxy) |
| docs/superpowers/specs/2026-07-11-run-proxy-blue-green-zero-downtime-restart-design.md | reviewed | blue-green-container-swap-for-restarts |
| docs/superpowers/specs/2026-07-12-vm-test-wsl-mirrored-networking-design.md | reviewed | vm-tests-via-qemu-in-wsl2 |
| docs/superpowers/specs/2026-07-13-vm-shared-windows-design.md | reviewed | transparent-interception-and-network-isolation-boundary (DNS-redirect-not-forward-proxy + host-only-is-the-boundary); C# responder later overtaken |
| docs/superpowers/specs/2026-07-13-vscode-install-and-config-design.md | reviewed | — (tooling feature, fails gate) |
| docs/superpowers/specs/2026-07-14-dns-responder-rerun-safe-design.md | reviewed | — (obsolete: in-guest C# responder deleted) |
| docs/superpowers/specs/2026-07-15-dns-responder-readonly-build-design.md | reviewed | — (obsolete: in-guest C# responder deleted) |
| docs/superpowers/specs/2026-07-15-jq-for-json-writes-design.md | reviewed | user-customizable-committable-environment |
| docs/superpowers/specs/2026-07-18-allowlist-pragma-auth-candidate-design.md | reviewed | allowlist-format-and-parse-trust-boundary, credential-injection-at-proxy |
| docs/honist-v/specs/2026-07-18-allowlist-collision-prioritization-design.md | reviewed | allowlist-format-and-parse-trust-boundary |
| docs/honist-v/specs/2026-07-18-run-proxy-robustness-design.md | reviewed | — (robustness hardening of blue-green; no standalone decision) |
| docs/honist-v/specs/2026-07-19-github-auth-scheme-fix-design.md | reviewed | — (fix detail folded into credential-injection-at-proxy) |
| docs/honist-v/specs/2026-07-19-github-credential-injection-design.md | reviewed | credential-injection-at-proxy |
| docs/honist-v/specs/2026-07-20-codex-credential-injection-design.md | reviewed | credential-injection-at-proxy |
| docs/honist-v/specs/2026-07-20-customizable-jq-transforms-design.md | reviewed | user-customizable-committable-environment |
| docs/honist-v/specs/2026-07-20-proxy-access-log-diagnostic-fields-design.md | reviewed | envoy-access-log-contract |
| docs/honist-v/specs/2026-07-21-auth-gate-passthrough-design.md | reviewed | credential-injection-at-proxy |
| docs/honist-v/specs/2026-07-21-custom-scripts-design.md | reviewed | user-customizable-committable-environment |
| docs/honist-v/specs/2026-07-22-host-side-dns-consolidation-design.md | reviewed | host-side-dns-and-dhcp |
| docs/honist-v/specs/2026-07-22-remove-vmware-support-design.md | reviewed | hyper-v-only-target |
| docs/honist-v/specs/2026-07-25-decouple-seed-content-tests-design.md | reviewed | — (testing hygiene, fails gate) |
| docs/honist-v/specs/2026-07-25-documentation-gaps-design.md | reviewed | — (doc wording reconciliation) |
| docs/honist-v/specs/2026-07-25-host-firewall-confinement-design.md | reviewed | transparent-interception-and-network-isolation-boundary (host-side firewall enforcement + dedicated node.exe) |
| docs/honist-v/specs/2026-07-25-relocate-test-environment-design.md | reviewed | — (testing hygiene, fails gate) |
| docs/honist-v/specs/2026-07-25-verifier-script-defects-design.md | reviewed | — (verifier bug fixes, fail gate) |
| technical-notes.md | reviewed | vm-tests-via-qemu-in-wsl2 (fullest source); reinforces (dedupe) egress-through-host-envoy-proxy, credential-injection-at-proxy, run-proxy-owns-proxy-lifecycle, blue-green-container-swap-for-restarts, loopback-publish-with-node-forwarder, envoy-access-log-contract, host-side-dns-and-dhcp, per-directory-environment-model, allowlist-format-and-parse-trust-boundary |

## Plan and investigation pass

Processed in the requested order: all `docs/superpowers/plans` by filename date,
then all `docs/honist-v/plans` by filename date, then `docs/investigations` as
supporting evidence. Same-date ties use filename order.

| Source document | Status | Drafts produced |
| --- | --- | --- |
| docs/superpowers/plans/2026-07-01-susentorno-cli.md | reviewed | allowlist-format-and-parse-trust-boundary |
| docs/superpowers/plans/2026-07-01-envoy-proxy-stack.md | reviewed | egress-through-host-envoy-proxy, credential-injection-at-proxy, root-ca-plus-derived-leaf, transparent-interception-and-network-isolation-boundary |
| docs/superpowers/plans/2026-07-03-vm-github-auth.md | reviewed | — (overtaken; history folded into credential-injection-at-proxy) |
| docs/superpowers/plans/2026-07-04-vm-dns-netplan-merge-and-iptables-path.md | reviewed | — (obsolete in-guest layer; history in host-side-dns-and-dhcp) |
| docs/superpowers/plans/2026-07-04-vm-dns-stub-dnsmasq.md | reviewed | — (obsolete in-guest layer; history in host-side-dns-and-dhcp) |
| docs/superpowers/plans/2026-07-04-vm-dns-stub.md | reviewed | — (obsolete in-guest layer; history in host-side-dns-and-dhcp) |
| docs/superpowers/plans/2026-07-05-susentorno-environments.md | reviewed | per-directory-environment-model |
| docs/superpowers/plans/2026-07-05-run-proxy-credential-monitor.md | reviewed | run-proxy-owns-proxy-lifecycle, no-oauth-refresh-piggyback-host-cli |
| docs/superpowers/plans/2026-07-05-vm-host-only-default-route.md | reviewed | — (obsolete in-guest layer; history in host-side-dns-and-dhcp) |
| docs/superpowers/plans/2026-07-06-proxy-logging.md | reviewed | envoy-access-log-contract |
| docs/superpowers/plans/2026-07-06-vm-e2e-test-harness.md | reviewed | vm-tests-via-qemu-in-wsl2 |
| docs/superpowers/plans/2026-07-07-allowlist-dedup.md | reviewed | allowlist-format-and-parse-trust-boundary |
| docs/superpowers/plans/2026-07-07-verify-scripts.md | reviewed | — (diagnostic feature; fails ADR gate) |
| docs/superpowers/plans/2026-07-08-envoy-http80-wildcard.md | reviewed | allowlist-format-and-parse-trust-boundary |
| docs/superpowers/plans/2026-07-09-proxy-ca-leaf-split.md | reviewed | root-ca-plus-derived-leaf |
| docs/superpowers/plans/2026-07-09-vm-egress-host-forwarder.md | reviewed | loopback-publish-with-node-forwarder |
| docs/superpowers/plans/2026-07-10-susentorno-egress-service-idempotent.md | reviewed | — (obsolete in-guest service) |
| docs/superpowers/plans/2026-07-10-run-proxy-merge-config-and-logging.md | reviewed | run-proxy-owns-proxy-lifecycle |
| docs/superpowers/plans/2026-07-10-single-star-wildcard.md | reviewed | allowlist-format-and-parse-trust-boundary |
| docs/superpowers/plans/2026-07-10-vm-claude-config-script.md | reviewed | credential-injection-at-proxy |
| docs/superpowers/plans/2026-07-11-run-proxy-blue-green-zero-downtime-restart.md | reviewed | blue-green-container-swap-for-restarts |
| docs/superpowers/plans/2026-07-12-vm-test-wsl-mirrored-networking.md | reviewed | vm-tests-via-qemu-in-wsl2 |
| docs/superpowers/plans/2026-07-13-vm-shared-windows.md | reviewed | transparent-interception-and-network-isolation-boundary |
| docs/superpowers/plans/2026-07-14-dns-responder-rerun-safe.md | reviewed | — (obsolete in-guest responder) |
| docs/superpowers/plans/2026-07-15-dns-responder-readonly-build.md | reviewed | — (obsolete in-guest responder) |
| docs/superpowers/plans/2026-07-15-jq-for-json-writes.md | reviewed | user-customizable-committable-environment |
| docs/superpowers/plans/2026-07-18-allowlist-pragma-auth-candidate.md | reviewed | allowlist-format-and-parse-trust-boundary, credential-injection-at-proxy |
| docs/honist-v/plans/2026-07-18-allowlist-collision-prioritization.md | reviewed | allowlist-format-and-parse-trust-boundary |
| docs/honist-v/plans/2026-07-18-run-proxy-robustness.md | reviewed | — (robustness hardening; fails ADR gate) |
| docs/honist-v/plans/2026-07-19-github-auth-scheme-fix.md | reviewed | credential-injection-at-proxy |
| docs/honist-v/plans/2026-07-19-github-credential-injection.md | reviewed | credential-injection-at-proxy |
| docs/honist-v/plans/2026-07-20-codex-credential-injection.md | reviewed | credential-injection-at-proxy |
| docs/honist-v/plans/2026-07-20-proxy-access-log-diagnostic-fields.md | reviewed | envoy-access-log-contract |
| docs/honist-v/plans/2026-07-21-auth-gate-passthrough.md | reviewed | credential-injection-at-proxy |
| docs/honist-v/plans/2026-07-21-customizable-jq-transforms.md | reviewed | user-customizable-committable-environment |
| docs/honist-v/plans/2026-07-22-custom-scripts.md | reviewed | user-customizable-committable-environment |
| docs/honist-v/plans/2026-07-22-host-side-dns-consolidation.md | reviewed | host-side-dns-and-dhcp |
| docs/honist-v/plans/2026-07-22-remove-vmware-support.md | reviewed | hyper-v-only-target |
| docs/honist-v/plans/2026-07-25-decouple-seed-content-tests.md | reviewed | — (testing hygiene; fails ADR gate) |
| docs/honist-v/plans/2026-07-25-documentation-gaps.md | reviewed | — (documentation reconciliation; fails ADR gate) |
| docs/honist-v/plans/2026-07-25-host-firewall-confinement.md | reviewed | transparent-interception-and-network-isolation-boundary |
| docs/honist-v/plans/2026-07-25-relocate-test-environment.md | reviewed | — (testing hygiene; fails ADR gate) |
| docs/honist-v/plans/2026-07-25-verifier-script-defects.md | reviewed | — (bug fixes; fail ADR gate) |
| docs/investigations/2026-07-11-proxy-restart-swap-window-race.txt | reviewed | blue-green-container-swap-for-restarts |
| docs/investigations/2026-07-12-streaming-response-cut-by-envoy-route-timeout.md | reviewed | — (localized timeout safeguard; fails hard-to-reverse gate) |
| docs/investigations/2026-07-18-envoy-crash-loop-vs-docker-state-running.md | reviewed | — (localized liveness safeguard; fails hard-to-reverse gate) |
| docs/investigations/2026-07-22-host-side-dns-consolidation.md | reviewed | host-side-dns-and-dhcp |
| docs/investigations/2026-07-22-remote-control-session-token-rejected-by-claude-gate.md | reviewed | credential-injection-at-proxy |
| docs/investigations/2026-07-22-windows-specific-ip-port-53-bind.md | reviewed | host-side-dns-and-dhcp |
| docs/investigations/2026-07-23-host-model-lets-guest-reach-other-host-ips.md | reviewed | transparent-interception-and-network-isolation-boundary |

## Note — technical-notes.md

Ingested on request as an additional source; the file is being **kept in place**, not retired.
As a distillation of the shipped design it introduced no new decision: every section maps onto
a draft already produced from the specs (dedupe column above). Its "Testing" section is the
fullest current description of the VM harness and is the primary source for
`vm-tests-via-qemu-in-wsl2`.
