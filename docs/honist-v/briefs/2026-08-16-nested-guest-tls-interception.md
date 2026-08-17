# A nested VM inherits its host's TLS-intercepting proxy, but not the proxy's CA

## Summary

A Windows machine sits behind a TLS-intercepting HTTP proxy. The machine trusts
the proxy's CA, so its own HTTPS works. The machine then runs Hyper-V and boots a
Linux VM on the **Default Switch**.

That nested VM reaches the internet through the Windows machine (Hyper-V ICS:
NAT plus a DNS proxy). It therefore inherits the interception — but nothing has
put the proxy's CA into the *Linux* trust store. Every host the proxy
TLS-terminates fails certificate verification inside the nested VM, while every
host the proxy merely passes through works normally.

The result is a confusing partial failure: most of the network works, `apt` over
HTTP works, some HTTPS works, and a specific subset of HTTPS hosts fails with

```
curl: (60) SSL certificate OpenSSL verify result: unable to get local issuer certificate (20)
```

This is a property of the environment, not of any particular software being
tested inside the nested VM.

## Topology

```
  LAN proxy (TLS-intercepting)        192.168.67.1     also the LAN's DNS server
        |
        |  outer machine trusts the proxy CA (Windows trust store)
        v
  Windows host                        192.168.67.50    Ethernet
        |                                              DNS -> 192.168.67.1
        |  Hyper-V "Default Switch": ICS NAT + DNS proxy
        v
  Nested Linux VM                     172.19.217.135/20
                                      gateway/DNS -> 172.19.208.1 (the Windows host)
                                      does NOT trust the proxy CA
```

Egress path for the nested VM:

```
nested VM -> 172.19.208.1 (ICS) -> Windows host resolver -> 192.168.67.1 (proxy) -> internet
```

DNS follows the same path, so the nested VM resolves names exactly as the
Windows host does, including any name the proxy answers for itself.

## What makes it partial rather than total

The proxy handles two classes of host differently:

- **Passthrough hosts** — a plain TCP relay. The client completes TLS with the
  real origin and sees the origin's real certificate. These work in the nested VM.
- **Terminated hosts** — the proxy completes TLS itself, presenting a leaf signed
  by its own CA, so it can inspect or rewrite the traffic (for example, to
  substitute a credential). These fail in the nested VM.

Observed from the Windows host, which is exactly what the nested VM inherits:

```
github.com                    -> issuer CN=susentorno-proxy-certificate-authority   TERMINATED
get.pnpm.io                   -> issuer CN=YR2, O=Let's Encrypt, C=US               passthrough
objects.githubusercontent.com -> issuer CN=YR1, O=Let's Encrypt, C=US               passthrough
```

A third class matters too: hosts the proxy does not permit at all are refused
outright, which is a different failure with a different fix (allow-listing).
Distinguishing "not permitted" from "terminated but untrusted" is the main
diagnostic difficulty here — both look like "the network is broken."

## Concrete reproduction

An installer that fetches a script from a passthrough host and then fetches a
binary from a terminated host reproduces it in one command. `pnpm`'s installer
happens to do exactly this:

```sh
# inside the nested Linux VM
curl -fsSL https://get.pnpm.io/install.sh | bash -
```

Output:

```
==> Downloading pnpm binaries 11.22.0
curl: (60) SSL certificate OpenSSL verify result: unable to get local issuer certificate (20)
More details here: https://curl.se/docs/sslcerts.html
Install Error!
```

The first fetch succeeds — `get.pnpm.io` is passthrough, and `install.sh` runs far
enough to print its own banner. The failure is the second fetch. From
`install.sh`:

```sh
archive_url="https://github.com/pnpm/pnpm/releases/download/v${version}/${asset_base}"
```

`github.com` is terminated, so `curl` correctly rejects a certificate signed by a
CA it has never heard of.

### Minimal version, no installer involved

```sh
# inside the nested Linux VM
curl -sS https://get.pnpm.io/  -o /dev/null && echo "passthrough host OK"
curl -sS https://github.com/   -o /dev/null || echo "terminated host FAILS"
openssl s_client -connect github.com:443 -servername github.com </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer
```

The last command prints the proxy's CA rather than a public one. That single line
is the whole diagnosis.

### Confirming it from the Windows host

```powershell
# who the machine resolves through
Get-DnsClientServerAddress -AddressFamily IPv4 |
  Where-Object { $_.ServerAddresses } |
  Select-Object InterfaceAlias, @{n='DNS';e={$_.ServerAddresses -join ', '}}

# which CA signs a given host's certificate
foreach ($h in 'github.com','get.pnpm.io') {
  $c = New-Object Net.Sockets.TcpClient($h, 443)
  $s = New-Object Net.Security.SslStream($c.GetStream(), $false, {$true})
  $s.AuthenticateAsClient($h)
  $cert = New-Object Security.Cryptography.X509Certificates.X509Certificate2($s.RemoteCertificate)
  "{0} -> {1}" -f $h, $cert.Issuer
  $s.Dispose(); $c.Dispose()
}

# the CA the outer machine trusts and the nested VM does not
Get-ChildItem Cert:\LocalMachine\Root |
  Where-Object { $_.Subject -like '*proxy-certificate-authority*' } |
  Select-Object Subject, Thumbprint
```

## Why the obvious fix does not work

Allow-listing the host named in the error message does not help. The error names
the *script* host only because that is where the installer started; the failing
host is the one the installer redirects to. And in this case the failing host is
not blocked at all — it is permitted and deliberately terminated. Adding it to an
allow list changes nothing about the certificate the nested VM is offered.

Editing a *seed* or *template* allow list also has no effect on a proxy that is
already running: a running proxy reads its own live configuration file, and seed
files only apply to environments created afterwards.

## Remedies, in rough order of preference

1. **Install the proxy's CA into the nested VM before its first HTTPS call.**
   Export it from the outer machine's trust store by thumbprint, deliver it to the
   nested VM by whatever channel already exists (a mounted share, a build-time
   image customisation), and run `update-ca-certificates`. Note that
   Node.js ignores the system store, so `NODE_EXTRA_CA_CERTS` must point at the
   same file for Node-based tooling.

   If this is being automated, drive the CA from configuration — an environment
   variable or an optional file path — rather than hardcoding one machine's CA
   into a shared harness. The CA is specific to the outer environment.

2. **Give the nested VM an egress path that does not traverse the proxy.** Usually
   impossible, since all of its traffic leaves through the outer machine.

3. **Make the offending host passthrough rather than terminated** in the outer
   proxy's configuration. Cheap, but it disables whatever the termination existed
   to do (credential substitution, inspection), so it trades one property for
   another.

4. **Run the nested-VM workload on a machine that is not itself behind an
   intercepting proxy.** The most reliable option when the nested VM is meant to
   model a clean machine, because any CA installed for reason 1 is an extra
   trusted issuer that the clean-machine model does not otherwise have.

## Generalisation

Any layered setup with these three properties will show this:

- an outer boundary that terminates TLS for a subset of hosts,
- an inner environment that inherits the outer boundary's routing and DNS,
- trust configuration that was applied to the outer environment only.

Container-in-VM, VM-in-VM, WSL-under-an-intercepted-Windows-host, and CI runners
behind corporate TLS inspection are all the same shape. The inner environment is
usually built from a pristine base image precisely so that it is clean — and
being clean is exactly what makes it distrust the boundary it now sits behind.
