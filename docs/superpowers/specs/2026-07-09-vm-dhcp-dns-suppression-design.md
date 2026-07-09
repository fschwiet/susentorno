# VM DHCP DNS suppression (2026-07-09)

## Problem

On a freshly provisioned host-only VM, `verify-config.sh` failed intermittently:
allow-listed `:80` requests timed out (`code=000 curlExit=28`), a blocked `:80`
check sometimes got no response instead of Envoy's 403, a blocked `:443` check
sometimes timed out instead of being reset, and in one run `dig example.com`
via the default resolver timed out against `127.0.0.53` while `dig @127.0.0.1`
answered instantly. Which checks failed varied run to run; the requests that
failed left no trace in Envoy's access log, while requests seconds before and
after them (including the VM's own `connectivity-check.ubuntu.com` probes)
went through normally.

## Root cause

The failing requests never left the VM: they died inside name resolution.

- VMware's host-only DHCP (`vmnetdhcp.conf`, VMnet1 subnet) hands every VM
  `option domain-name-servers 192.168.241.1` — the Windows host's VMnet1 IP.
- Nothing on the host serves DNS to the VM there: the host's UDP `:53` is
  owned by the ICS service (`SharedAccess`), which rejects queries arriving on
  VMnet1, and the sandbox firewall rule admits only TCP 80/443 anyway.
- The netplan override (`60-dns-override.yaml`) declared `dhcp4: true` plus
  static `nameservers: [127.0.0.1]`. The 2026-07-04 netplan-merge spec assumed
  this also set `ipv4.ignore-auto-dns` at the NetworkManager layer. It does
  not: netplan's NM keyfile generator (`src/nm.c`) never emits
  `ignore-auto-dns`, so static nameservers merely ADD to the DHCP-supplied
  ones. Verified empirically with netplan 1.1.2 in an Ubuntu 24.04 container:
  the old template generates `dns=127.0.0.1;` with no `ignore-auto-dns`.

systemd-resolved therefore had two upstreams on the link — the dnsmasq stub
and a black-hole server — and rotates its "current server" on failure. Any
lookup that lands on the dead server stalls through resolved's retry cycle;
curl burns its entire `--max-time` inside `getaddrinfo` and exits 28 with
`http_code=000` before a single packet reaches the forwarder. This produced
every VM-side networking failure observed, including the `127.0.0.53` timeout
(the check caught resolved mid-stall).

## Change

- `templates/vm-shared/60-dns-override.yaml` suppresses DHCP DNS on both
  renderers: `dhcp4-overrides: use-dns: false` (honored by networkd only) and
  `networkmanager: passthrough: ipv4.ignore-auto-dns: "true"` (the NM keyfile
  passthrough; `use-dns` has no effect on the NM renderer per netplan docs).
  The fixed template generates `ignore-auto-dns=true` in the NM profile.
- `templates/vm-shared/verify-config.sh` now asserts `127.0.0.1` is the ONLY
  resolver `resolvectl` lists, not merely present — the old check passed on a
  broken VM.
- `tests/unit/templates.test.ts` pins both suppression keys in the template.

Existing VMs are repaired by re-copying the template and re-running
`07-setup-persistence.sh <host-ip>` (or just `sudo netplan apply` after
updating `/etc/netplan/60-dns-override.yaml`).

## Corrects

The claim in `2026-07-04-vm-dns-netplan-merge-and-iptables-path-design.md`
that DHCP-supplied DNS "is thereby overridden (`ipv4.ignore-auto-dns` +
`ipv4.dns` at the NM layer)" — only `ipv4.dns` was ever set.
