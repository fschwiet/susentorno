import { describe, it, expect } from 'vitest';
import { generateEnvoyConfig } from '../../src/envoyConfig';
import type { Allowlist } from '../../src/allowlist';

const allowlist: Allowlist = {
  passthrough: ['*.chatgpt.com:443', 'archive.ubuntu.com:80'],
  claudeAuthenticated: ['api.anthropic.com:443'],
  githubAuthenticated: [],
  authCandidate: [],
  warnings: [],
};

describe('generateEnvoyConfig', () => {
  it('builds a claude filter chain and cluster for each claude-authenticated host', () => {
    const config = generateEnvoyConfig(allowlist) as any;
    const listener443 = config.static_resources.listeners.find(
      (l: any) => l.name === 'listener_443',
    );
    const claudeChain = listener443.filter_chains.find((fc: any) =>
      fc.filter_chain_match?.server_names?.includes('api.anthropic.com'),
    );

    expect(claudeChain).toBeDefined();
    const hcm = claudeChain.filters[0].typed_config;
    expect(hcm['@type']).toBe(
      'type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager',
    );
    expect(hcm.route_config.virtual_hosts[0].routes[0].route.cluster).toBe(
      'cluster_claude_api_anthropic_com',
    );
    // timeout '0s' disables Envoy's default 15s route timeout so long streaming
    // (SSE) responses are not severed mid-response. See
    // docs/investigations/2026-07-12-streaming-response-cut-by-envoy-route-timeout.md
    expect(hcm.route_config.virtual_hosts[0].routes[0].route.timeout).toBe('0s');
    expect(hcm.http_filters.map((f: any) => f.name)).toEqual([
      'envoy.filters.http.lua',
      'envoy.filters.http.credential_injector',
      'envoy.filters.http.router',
    ]);

    const cluster = config.static_resources.clusters.find(
      (c: any) => c.name === 'cluster_claude_api_anthropic_com',
    );
    expect(
      cluster.load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address,
    ).toEqual({ address: 'api.anthropic.com', port_value: 443 });
    expect(cluster.transport_socket.typed_config['@type']).toBe(
      'type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext',
    );
  });

  it('redirects a claude cluster to the override target and disables upstream cert validation', () => {
    const config = generateEnvoyConfig(allowlist, {
      overrides: [{ sniHost: 'api.anthropic.com', target: '127.0.0.1:9443' }],
    }) as any;

    const cluster = config.static_resources.clusters.find(
      (c: any) => c.name === 'cluster_claude_api_anthropic_com',
    );
    expect(
      cluster.load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address,
    ).toEqual({ address: '127.0.0.1', port_value: 9443 });
    expect(
      cluster.transport_socket.typed_config.common_tls_context.validation_context
        .trust_chain_verification,
    ).toBe('ACCEPT_UNTRUSTED');
  });

  it('routes all passthrough 443 entries through a single SNI dynamic-forward-proxy filter chain', () => {
    const config = generateEnvoyConfig(allowlist) as any;
    const listener443 = config.static_resources.listeners.find(
      (l: any) => l.name === 'listener_443',
    );
    const passthroughChain = listener443.filter_chains.find((fc: any) =>
      fc.filter_chain_match?.server_names?.includes('*.chatgpt.com'),
    );

    expect(passthroughChain).toBeDefined();
    expect(passthroughChain.filters.map((f: any) => f.name)).toEqual([
      'envoy.filters.network.sni_dynamic_forward_proxy',
      'envoy.filters.network.tcp_proxy',
    ]);

    const dfpCluster = config.static_resources.clusters.find(
      (c: any) => c.name === 'dynamic_forward_proxy_cluster',
    );
    expect(dfpCluster.cluster_type.name).toBe('envoy.clusters.dynamic_forward_proxy');
  });

  it('routes each passthrough port-80 host by Host header to its own cluster, with a 403 default', () => {
    const config = generateEnvoyConfig(allowlist) as any;
    const listener80 = config.static_resources.listeners.find((l: any) => l.name === 'listener_80');
    const hcm = listener80.filter_chains[0].filters[0].typed_config;
    const vhosts = hcm.route_config.virtual_hosts;

    const ubuntuVhost = vhosts.find((v: any) => v.domains.includes('archive.ubuntu.com'));
    expect(ubuntuVhost.routes[0].route.cluster).toBe('cluster_http_archive_ubuntu_com');

    const defaultVhost = vhosts.find((v: any) => v.domains.includes('*'));
    expect(defaultVhost.routes[0].direct_response.status).toBe(403);

    const cluster = config.static_resources.clusters.find(
      (c: any) => c.name === 'cluster_http_archive_ubuntu_com',
    );
    expect(
      cluster.load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address,
    ).toEqual({ address: 'archive.ubuntu.com', port_value: 80 });
  });

  it('exposes an admin endpoint for readiness checks', () => {
    const config = generateEnvoyConfig(allowlist) as any;
    expect(config.admin.address.socket_address.port_value).toBe(9901);
  });

  it('leaves the admin port at 9901 with no fault', () => {
    const config = generateEnvoyConfig(allowlist) as any;
    expect(config.admin.address.socket_address.port_value).toBe(9901);
  });

  it('crash-config sets the admin port out of range (70000)', () => {
    const config = generateEnvoyConfig(allowlist, { fault: 'crash-config' }) as any;
    expect(config.admin.address.socket_address.port_value).toBe(70000);
  });

  it('never-ready moves the admin port off 9901 (to 9902)', () => {
    const config = generateEnvoyConfig(allowlist, { fault: 'never-ready' }) as any;
    expect(config.admin.address.socket_address.port_value).toBe(9902);
  });

  it('tags every path with a CFGM access log to stdout', () => {
    const config = generateEnvoyConfig(allowlist) as any;
    const listener443 = config.static_resources.listeners.find(
      (l: any) => l.name === 'listener_443',
    );
    const listener80 = config.static_resources.listeners.find((l: any) => l.name === 'listener_80');

    const termChain = listener443.filter_chains.find((fc: any) =>
      fc.filter_chain_match?.server_names?.includes('api.anthropic.com'),
    );
    const termLog = termChain.filters[0].typed_config.access_log[0];
    expect(termLog.name).toBe('envoy.access_loggers.file');
    expect(termLog.typed_config.path).toBe('/dev/stdout');
    expect(termLog.typed_config.log_format.text_format_source.inline_string).toMatch(
      /^CFGM\|term\|/,
    );

    const passChain = listener443.filter_chains.find((fc: any) =>
      fc.filter_chain_match?.server_names?.includes('*.chatgpt.com'),
    );
    const passTcp = passChain.filters.find(
      (f: any) => f.name === 'envoy.filters.network.tcp_proxy',
    ).typed_config;
    expect(passTcp.access_log[0].typed_config.log_format.text_format_source.inline_string).toMatch(
      /^CFGM\|pass\|/,
    );

    const httpLog =
      listener80.filter_chains[0].filters[0].typed_config.access_log[0].typed_config.log_format
        .text_format_source.inline_string;
    expect(httpLog).toMatch(/^CFGM\|http\|/);
  });

  it('routes wildcard :80 hosts through a shared dynamic_forward_proxy_cluster_http', () => {
    const wildcardAllowlist: Allowlist = {
      passthrough: ['*.ubuntu.com:80', 'security.ubuntu.com:80'],
      claudeAuthenticated: ['api.anthropic.com:443'],
      githubAuthenticated: [],
      authCandidate: [],
      warnings: [],
    };
    const config = generateEnvoyConfig(wildcardAllowlist) as any;
    const listener80 = config.static_resources.listeners.find((l: any) => l.name === 'listener_80');
    const hcm = listener80.filter_chains[0].filters[0].typed_config;
    const vhosts = hcm.route_config.virtual_hosts;

    const wildcardVhost = vhosts.find((v: any) => v.domains.includes('*.ubuntu.com'));
    expect(wildcardVhost.routes[0].route.cluster).toBe('dynamic_forward_proxy_cluster_http');

    const exactVhost = vhosts.find((v: any) => v.domains.includes('security.ubuntu.com'));
    expect(exactVhost.routes[0].route.cluster).toBe('cluster_http_security_ubuntu_com');

    expect(hcm.http_filters.map((f: any) => f.name)).toEqual([
      'envoy.filters.http.dynamic_forward_proxy',
      'envoy.filters.http.router',
    ]);

    const cluster = config.static_resources.clusters.find(
      (c: any) => c.name === 'dynamic_forward_proxy_cluster_http',
    );
    expect(cluster.lb_policy).toBe('CLUSTER_PROVIDED');
    expect(cluster.cluster_type.name).toBe('envoy.clusters.dynamic_forward_proxy');
    expect(cluster.cluster_type.typed_config.dns_cache_config.name).toBe(
      'dynamic_forward_proxy_cache_config_http',
    );
  });

  it('omits the shared http dynamic_forward_proxy cluster and filter when there are no wildcard :80 entries', () => {
    const config = generateEnvoyConfig(allowlist) as any;
    const listener80 = config.static_resources.listeners.find((l: any) => l.name === 'listener_80');
    const hcm = listener80.filter_chains[0].filters[0].typed_config;

    expect(hcm.http_filters.map((f: any) => f.name)).toEqual(['envoy.filters.http.router']);
    expect(
      config.static_resources.clusters.find(
        (c: any) => c.name === 'dynamic_forward_proxy_cluster_http',
      ),
    ).toBeUndefined();
  });

  it('serves the leaf certificate (not the root CA) on TLS-terminating chains', () => {
    const config = generateEnvoyConfig(allowlist) as any;
    const listener443 = config.static_resources.listeners.find(
      (l: any) => l.name === 'listener_443',
    );
    const claudeChain = listener443.filter_chains.find((fc: any) =>
      fc.filter_chain_match?.server_names?.includes('api.anthropic.com'),
    );
    const tls = claudeChain.transport_socket.typed_config.common_tls_context.tls_certificates[0];
    expect(tls.certificate_chain.filename).toBe('/etc/envoy/ca/leaf-cert.pem');
    expect(tls.private_key.filename).toBe('/etc/envoy/ca/leaf-key.pem');
  });

  it('adds a default_filter_chain that logs blocked SNI and routes to the blackhole cluster', () => {
    const config = generateEnvoyConfig(allowlist) as any;
    const listener443 = config.static_resources.listeners.find(
      (l: any) => l.name === 'listener_443',
    );

    const fallback = listener443.default_filter_chain;
    expect(fallback).toBeDefined();
    const tcp = fallback.filters.find(
      (f: any) => f.name === 'envoy.filters.network.tcp_proxy',
    ).typed_config;
    expect(tcp.cluster).toBe('blackhole');
    expect(tcp.access_log[0].typed_config.log_format.text_format_source.inline_string).toMatch(
      /^CFGM\|deny443\|/,
    );

    const blackhole = config.static_resources.clusters.find((c: any) => c.name === 'blackhole');
    expect(blackhole).toBeDefined();
    expect(blackhole.load_assignment.endpoints).toEqual([]);
  });
});

describe('generateEnvoyConfig auth candidate', () => {
  const candAllowlist: Allowlist = {
    passthrough: [],
    claudeAuthenticated: ['api.anthropic.com:443'],
    githubAuthenticated: [],
    authCandidate: ['partner.example.com:443'],
    warnings: [],
  };

  it('builds an auth-candidate chain with only the router http filter', () => {
    const config = generateEnvoyConfig(candAllowlist) as any;
    const listener443 = config.static_resources.listeners.find(
      (l: any) => l.name === 'listener_443',
    );
    const chain = listener443.filter_chains.find((fc: any) =>
      fc.filter_chain_match?.server_names?.includes('partner.example.com'),
    );
    expect(chain).toBeDefined();
    const hcm = chain.filters[0].typed_config;
    expect(hcm.http_filters.map((f: any) => f.name)).toEqual(['envoy.filters.http.router']);
    expect(hcm.route_config.virtual_hosts[0].routes[0].route.cluster).toBe(
      'cluster_authcandidate_partner_example_com',
    );
  });

  it('serves the leaf cert and builds an override-aware cluster', () => {
    const config = generateEnvoyConfig(candAllowlist, {
      overrides: [{ sniHost: 'partner.example.com', target: '127.0.0.1:9443' }],
    }) as any;
    const listener443 = config.static_resources.listeners.find(
      (l: any) => l.name === 'listener_443',
    );
    const chain = listener443.filter_chains.find((fc: any) =>
      fc.filter_chain_match?.server_names?.includes('partner.example.com'),
    );
    const tls = chain.transport_socket.typed_config.common_tls_context.tls_certificates[0];
    expect(tls.certificate_chain.filename).toBe('/etc/envoy/ca/leaf-cert.pem');

    const cluster = config.static_resources.clusters.find(
      (c: any) => c.name === 'cluster_authcandidate_partner_example_com',
    );
    expect(
      cluster.load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address,
    ).toEqual({ address: '127.0.0.1', port_value: 9443 });
    expect(
      cluster.transport_socket.typed_config.common_tls_context.validation_context
        .trust_chain_verification,
    ).toBe('ACCEPT_UNTRUSTED');
  });

  it('logs the five auth headers truncated to 12 chars via a cand access log', () => {
    const config = generateEnvoyConfig(candAllowlist) as any;
    const listener443 = config.static_resources.listeners.find(
      (l: any) => l.name === 'listener_443',
    );
    const chain = listener443.filter_chains.find((fc: any) =>
      fc.filter_chain_match?.server_names?.includes('partner.example.com'),
    );
    const log =
      chain.filters[0].typed_config.access_log[0].typed_config.log_format.text_format_source
        .inline_string;
    expect(log).toMatch(/^CFGM\|cand\|/);
    expect(log).toContain('%REQ(AUTHORIZATION):12%');
    expect(log).toContain('%REQ(COOKIE):12%');
    expect(log).toContain('%REQ(X-API-KEY):12%');
    expect(log).toContain('%REQ(X-AUTH-TOKEN):12%');
    expect(log).toContain('%REQ(PROXY-AUTHORIZATION):12%');
  });
});

describe('generateEnvoyConfig github authenticated', () => {
  const ghAllowlist: Allowlist = {
    passthrough: [],
    claudeAuthenticated: ['api.anthropic.com:443'],
    githubAuthenticated: ['github.com:443', 'api.github.com:443'],
    authCandidate: [],
    warnings: [],
  };

  function githubChain(host: string) {
    const config = generateEnvoyConfig(ghAllowlist) as any;
    const listener443 = config.static_resources.listeners.find(
      (l: any) => l.name === 'listener_443',
    );
    return listener443.filter_chains.find((fc: any) =>
      fc.filter_chain_match?.server_names?.includes(host),
    );
  }

  it('builds a github.com Basic chain: inline lua gate, injector, router', () => {
    const chain = githubChain('github.com');
    expect(chain).toBeDefined();
    const hcm = chain.filters[0].typed_config;
    expect(hcm.http_filters.map((f: any) => f.name)).toEqual([
      'envoy.filters.http.lua',
      'envoy.filters.http.credential_injector',
      'envoy.filters.http.router',
    ]);
    // Gate is inline (no mounted file) and embeds a base64 decoder + placeholder check.
    const lua = hcm.http_filters[0].typed_config.default_source_code.inline_string;
    expect(lua).toContain('ghp-SANDBOX-PLACEHOLDER');
    expect(lua).toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/');
    expect(hcm.http_filters[0].typed_config.default_source_code.filename).toBeUndefined();
    // Injector reads the Basic SDS resource from its own single-resource secret file.
    const injector = hcm.http_filters[1].typed_config;
    expect(injector.overwrite).toBe(true);
    const cred = injector.credential.typed_config.credential;
    expect(cred.name).toBe('github_basic_auth');
    expect(cred.sds_config.path_config_source.path).toBe(
      '/etc/envoy/secrets/github-basic-secret.yaml',
    );
    expect(cred.sds_config.path_config_source.watched_directory.path).toBe('/etc/envoy/secrets');
    expect(hcm.route_config.virtual_hosts[0].routes[0].route.cluster).toBe(
      'cluster_github_github_com',
    );
    expect(hcm.route_config.virtual_hosts[0].routes[0].route.timeout).toBe('0s');
  });

  it('builds an api.github.com chain accepting either token or Bearer scheme', () => {
    const chain = githubChain('api.github.com');
    expect(chain).toBeDefined();
    const hcm = chain.filters[0].typed_config;
    const lua = hcm.http_filters[0].typed_config.default_source_code.inline_string;
    expect(lua).toContain('token ghp-SANDBOX-PLACEHOLDER');
    expect(lua).toContain('Bearer ghp-SANDBOX-PLACEHOLDER');
    // Still a plain exact match — no base64 decoder embedded (that's the Basic gate only).
    expect(lua).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
    const cred = hcm.http_filters[1].typed_config.credential.typed_config.credential;
    expect(cred.name).toBe('github_api_token');
    expect(cred.sds_config.path_config_source.path).toBe(
      '/etc/envoy/secrets/github-api-token-secret.yaml',
    );
  });

  it('serves the leaf cert and builds override-aware github clusters', () => {
    const config = generateEnvoyConfig(ghAllowlist, {
      overrides: [{ sniHost: 'github.com', target: '127.0.0.1:9443' }],
    }) as any;
    const listener443 = config.static_resources.listeners.find(
      (l: any) => l.name === 'listener_443',
    );
    const chain = listener443.filter_chains.find((fc: any) =>
      fc.filter_chain_match?.server_names?.includes('github.com'),
    );
    const tls = chain.transport_socket.typed_config.common_tls_context.tls_certificates[0];
    expect(tls.certificate_chain.filename).toBe('/etc/envoy/ca/leaf-cert.pem');

    const cluster = config.static_resources.clusters.find(
      (c: any) => c.name === 'cluster_github_github_com',
    );
    expect(
      cluster.load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address,
    ).toEqual({ address: '127.0.0.1', port_value: 9443 });
    expect(
      cluster.transport_socket.typed_config.common_tls_context.validation_context
        .trust_chain_verification,
    ).toBe('ACCEPT_UNTRUSTED');
  });
});
