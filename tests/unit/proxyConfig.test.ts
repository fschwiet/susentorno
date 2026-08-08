import { describe, it, expect } from 'vitest';
import {
  generateEnvoyConfig,
  NO_AUTH_MARKER_HEADER,
  NO_AUTH_SENTINEL_VALUE,
  NO_ACCOUNT_ID_MARKER_HEADER,
  NO_ACCOUNT_ID_SENTINEL_VALUE,
  AUTH_POST_FILTER_LUA,
} from '../../src/envoyConfig';
import type { Allowlist } from '../../src/allowlist';

describe('shared post-filter account-id cleanup', () => {
  it('AUTH_POST_FILTER_LUA also strips the account-id marker and header', () => {
    expect(AUTH_POST_FILTER_LUA).toContain(NO_ACCOUNT_ID_MARKER_HEADER);
    expect(AUTH_POST_FILTER_LUA).toContain('chatgpt-account-id');
  });
});

const allowlist: Allowlist = {
  passthrough: ['*.chatgpt.com:443', 'archive.ubuntu.com:80'],
  claudeAuthenticated: ['api.anthropic.com:443'],
  githubAuthenticated: [],
  codexAuthenticated: [],
  authCandidate: [],
  blocked: [],
  warnings: [],
};

describe('proxy configuration generation', () => {
  describe('claude credential channel', () => {
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
        'susentorno.auth_pre',
        'envoy.filters.http.credential_injector',
        'susentorno.auth_post',
        'envoy.filters.http.router',
      ]);
      expect(hcm.http_filters[0].typed_config.default_source_code.filename).toBe(
        '/etc/envoy/gate.lua',
      );
      expect(hcm.http_filters[1].typed_config.overwrite).toBe(false);
      expect(hcm.http_filters[2].typed_config.default_source_code.inline_string).toBe(
        AUTH_POST_FILTER_LUA,
      );

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

    it('does not add websocket upgrade support to the claude chain', () => {
      const config = generateEnvoyConfig(allowlist) as any;
      const listener443 = config.static_resources.listeners.find(
        (l: any) => l.name === 'listener_443',
      );
      const claudeChain = listener443.filter_chains.find((fc: any) =>
        fc.filter_chain_match?.server_names?.includes('api.anthropic.com'),
      );
      expect(claudeChain.filters[0].typed_config.upgrade_configs).toBeUndefined();
    });
  });

  describe('passthrough routing', () => {
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
      const listener80 = config.static_resources.listeners.find(
        (l: any) => l.name === 'listener_80',
      );
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

    it('routes wildcard :80 hosts through a shared dynamic_forward_proxy_cluster_http', () => {
      const wildcardAllowlist: Allowlist = {
        passthrough: ['*.ubuntu.com:80', 'security.ubuntu.com:80'],
        claudeAuthenticated: ['api.anthropic.com:443'],
        githubAuthenticated: [],
        codexAuthenticated: [],
        authCandidate: [],
        blocked: [],
        warnings: [],
      };
      const config = generateEnvoyConfig(wildcardAllowlist) as any;
      const listener80 = config.static_resources.listeners.find(
        (l: any) => l.name === 'listener_80',
      );
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
      const listener80 = config.static_resources.listeners.find(
        (l: any) => l.name === 'listener_80',
      );
      const hcm = listener80.filter_chains[0].filters[0].typed_config;

      expect(hcm.http_filters.map((f: any) => f.name)).toEqual(['envoy.filters.http.router']);
      expect(
        config.static_resources.clusters.find(
          (c: any) => c.name === 'dynamic_forward_proxy_cluster_http',
        ),
      ).toBeUndefined();
    });
  });

  describe('admin & readiness', () => {
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
  });

  describe('access logging', () => {
    it('tags every path with a CFGM access log to stdout, including response/duration/bytes fields', () => {
      const config = generateEnvoyConfig(allowlist) as any;
      const listener443 = config.static_resources.listeners.find(
        (l: any) => l.name === 'listener_443',
      );
      const listener80 = config.static_resources.listeners.find(
        (l: any) => l.name === 'listener_80',
      );

      const expectedSuffix = '|%RESPONSE_CODE%|%RESPONSE_FLAGS%|%DURATION%|%BYTES_SENT%\n';
      const expectedHttpSuffix =
        '|%RESPONSE_CODE%|%RESPONSE_FLAGS%|%DURATION%|%BYTES_SENT%|%ROUTE_NAME%\n';

      const termChain = listener443.filter_chains.find((fc: any) =>
        fc.filter_chain_match?.server_names?.includes('api.anthropic.com'),
      );
      const termLog = termChain.filters[0].typed_config.access_log[0];
      expect(termLog.name).toBe('envoy.access_loggers.file');
      expect(termLog.typed_config.path).toBe('/dev/stdout');
      const termFormat = termLog.typed_config.log_format.text_format_source.inline_string;
      expect(termFormat).toMatch(/^CFGM\|term\|/);
      expect(termFormat.endsWith(expectedSuffix)).toBe(true);

      const passChain = listener443.filter_chains.find((fc: any) =>
        fc.filter_chain_match?.server_names?.includes('*.chatgpt.com'),
      );
      const passTcp = passChain.filters.find(
        (f: any) => f.name === 'envoy.filters.network.tcp_proxy',
      ).typed_config;
      const passFormat =
        passTcp.access_log[0].typed_config.log_format.text_format_source.inline_string;
      expect(passFormat).toMatch(/^CFGM\|pass\|/);
      expect(passFormat.endsWith(expectedSuffix)).toBe(true);

      const httpFormat =
        listener80.filter_chains[0].filters[0].typed_config.access_log[0].typed_config.log_format
          .text_format_source.inline_string;
      expect(httpFormat).toMatch(/^CFGM\|http\|/);
      expect(httpFormat.endsWith(expectedHttpSuffix)).toBe(true);
    });
  });

  describe('leaf certificate & CA chain', () => {
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
  });

  describe('default deny chain', () => {
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
      const deny443Format =
        tcp.access_log[0].typed_config.log_format.text_format_source.inline_string;
      expect(deny443Format).toMatch(/^CFGM\|deny443\|/);
      expect(
        deny443Format.endsWith('|%RESPONSE_CODE%|%RESPONSE_FLAGS%|%DURATION%|%BYTES_SENT%\n'),
      ).toBe(true);

      const blackhole = config.static_resources.clusters.find((c: any) => c.name === 'blackhole');
      expect(blackhole).toBeDefined();
      expect(blackhole.load_assignment.endpoints).toEqual([]);
    });
  });

  describe('auth candidate credential channel', () => {
    const candAllowlist: Allowlist = {
      passthrough: [],
      claudeAuthenticated: ['api.anthropic.com:443'],
      githubAuthenticated: [],
      codexAuthenticated: [],
      authCandidate: ['partner.example.com:443'],
      blocked: [],
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

    it('does not add response/duration/bytes fields to the cand access log', () => {
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
      expect(log).not.toContain('%RESPONSE_CODE%');
      expect(log).not.toContain('%RESPONSE_FLAGS%');
      expect(log).not.toContain('%DURATION%');
      expect(log).not.toContain('%BYTES_SENT%');
    });
  });

  describe('github credential channel', () => {
    const ghAllowlist: Allowlist = {
      passthrough: [],
      claudeAuthenticated: ['api.anthropic.com:443'],
      githubAuthenticated: ['github.com:443', 'api.github.com:443'],
      codexAuthenticated: [],
      authCandidate: [],
      blocked: [],
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

    it('builds a github.com Basic chain: inline lua pre-filter, injector, shared post-filter, router', () => {
      const chain = githubChain('github.com');
      expect(chain).toBeDefined();
      const hcm = chain.filters[0].typed_config;
      expect(hcm.http_filters.map((f: any) => f.name)).toEqual([
        'susentorno.auth_pre',
        'envoy.filters.http.credential_injector',
        'susentorno.auth_post',
        'envoy.filters.http.router',
      ]);
      // Gate is inline (no mounted file) and embeds a base64 decoder + placeholder check.
      const lua = hcm.http_filters[0].typed_config.default_source_code.inline_string;
      expect(lua).toContain('ghp-susentorno-PLACEHOLDER');
      expect(lua).toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/');
      expect(lua).toContain(NO_AUTH_MARKER_HEADER);
      expect(lua).toContain(NO_AUTH_SENTINEL_VALUE);
      expect(lua).toContain(NO_ACCOUNT_ID_MARKER_HEADER);
      expect(lua).not.toContain('403');
      expect(hcm.http_filters[0].typed_config.default_source_code.filename).toBeUndefined();
      expect(hcm.http_filters[2].typed_config.default_source_code.inline_string).toBe(
        AUTH_POST_FILTER_LUA,
      );
      // Injector reads the Basic SDS resource from its own single-resource secret file.
      const injector = hcm.http_filters[1].typed_config;
      expect(injector.overwrite).toBe(false);
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
      expect(hcm.http_filters.map((f: any) => f.name)).toEqual([
        'susentorno.auth_pre',
        'envoy.filters.http.credential_injector',
        'susentorno.auth_post',
        'envoy.filters.http.router',
      ]);
      const lua = hcm.http_filters[0].typed_config.default_source_code.inline_string;
      expect(lua).toContain('token ghp-susentorno-PLACEHOLDER');
      expect(lua).toContain('Bearer ghp-susentorno-PLACEHOLDER');
      expect(lua).toContain(NO_AUTH_MARKER_HEADER);
      expect(lua).toContain(NO_AUTH_SENTINEL_VALUE);
      expect(lua).toContain(NO_ACCOUNT_ID_MARKER_HEADER);
      // Still a plain exact match — no base64 decoder embedded (that's the Basic gate only).
      expect(lua).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
      const injector = hcm.http_filters[1].typed_config;
      expect(injector.overwrite).toBe(false);
      const cred = injector.credential.typed_config.credential;
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

  describe('codex credential channel', () => {
    it('builds a codex filter chain with pre/injector/post lua filters, router, and websocket upgrade', () => {
      const codexAllowlist: Allowlist = {
        passthrough: [],
        claudeAuthenticated: [],
        githubAuthenticated: [],
        codexAuthenticated: ['chatgpt.com:443'],
        authCandidate: [],
        blocked: [],
        warnings: [],
      };
      const config = generateEnvoyConfig(codexAllowlist) as any;
      const listener443 = config.static_resources.listeners.find(
        (l: any) => l.name === 'listener_443',
      );
      const codexChain = listener443.filter_chains.find((fc: any) =>
        fc.filter_chain_match?.server_names?.includes('chatgpt.com'),
      );
      expect(codexChain).toBeDefined();

      const hcm = codexChain.filters[0].typed_config;
      expect(hcm.http_filters.map((f: any) => f.name)).toEqual([
        'susentorno.auth_pre',
        'envoy.filters.http.credential_injector',
        'susentorno.credential_injector.account_id',
        'susentorno.auth_post',
        'envoy.filters.http.router',
      ]);
      // Inline gate (not a mounted file) referencing the placeholder Bearer and the
      // shared no-auth marker/sentinel.
      const preLua = hcm.http_filters[0].typed_config.default_source_code.inline_string;
      expect(preLua).toContain('Bearer ');
      expect(preLua).toContain(NO_AUTH_MARKER_HEADER);
      expect(preLua).toContain(NO_AUTH_SENTINEL_VALUE);
      expect(preLua).not.toContain('403');
      // Shared, host-agnostic post-filter.
      const postLua = hcm.http_filters[3].typed_config.default_source_code.inline_string;
      expect(postLua).toBe(AUTH_POST_FILTER_LUA);
      // Codex-only websocket upgrade support.
      expect(hcm.upgrade_configs).toEqual([{ upgrade_type: 'websocket' }]);
      // Long-lived streaming: no route timeout.
      expect(hcm.route_config.virtual_hosts[0].routes[0].route.timeout).toBe('0s');

      const injector = hcm.http_filters[1].typed_config;
      expect(injector.overwrite).toBe(false);
      expect(injector.credential.typed_config.header).toBe('Authorization');
      expect(injector.credential.typed_config.credential.name).toBe('codex_bearer_token');
      expect(injector.credential.typed_config.credential.sds_config.path_config_source.path).toBe(
        '/etc/envoy/secrets/codex-secret.yaml',
      );

      const accountIdInjector = hcm.http_filters[2].typed_config;
      expect(accountIdInjector.overwrite).toBe(false);
      expect(accountIdInjector.credential.typed_config.header).toBe('chatgpt-account-id');
      expect(accountIdInjector.credential.typed_config.credential.name).toBe('codex_account_id');
      expect(
        accountIdInjector.credential.typed_config.credential.sds_config.path_config_source.path,
      ).toBe('/etc/envoy/secrets/codex-account-id-secret.yaml');

      const cluster = config.static_resources.clusters.find(
        (c: any) => c.name === 'cluster_codex_chatgpt_com',
      );
      expect(cluster).toBeDefined();
    });

    it('the codex pre-filter couples chatgpt-account-id handling to bearer recognition', () => {
      const codexAllowlist: Allowlist = {
        passthrough: [],
        claudeAuthenticated: [],
        githubAuthenticated: [],
        codexAuthenticated: ['chatgpt.com:443'],
        authCandidate: [],
        blocked: [],
        warnings: [],
      };
      const config = generateEnvoyConfig(codexAllowlist) as any;
      const listener443 = config.static_resources.listeners.find(
        (l: any) => l.name === 'listener_443',
      );
      const codexChain = listener443.filter_chains.find((fc: any) =>
        fc.filter_chain_match?.server_names?.includes('chatgpt.com'),
      );
      const preLua = codexChain.filters[0].typed_config.http_filters[0].typed_config
        .default_source_code.inline_string;
      expect(preLua).toContain('chatgpt-account-id');
      expect(preLua).toContain(NO_ACCOUNT_ID_MARKER_HEADER);
      expect(preLua).toContain(NO_ACCOUNT_ID_SENTINEL_VALUE);
    });
  });

  describe('host-run MCP servers', () => {
    it('builds a cleartext filter chain and cluster routed to host.docker.internal', () => {
      const config = generateEnvoyConfig(allowlist, {
        mcpServers: [{ hostname: 'filesystem.internal', port: 54321 }],
      }) as any;
      const listener443 = config.static_resources.listeners.find(
        (l: any) => l.name === 'listener_443',
      );
      const mcpChain = listener443.filter_chains.find((fc: any) =>
        fc.filter_chain_match?.server_names?.includes('filesystem.internal'),
      );

      expect(mcpChain).toBeDefined();
      expect(mcpChain.transport_socket.typed_config.common_tls_context.tls_certificates[0]).toEqual(
        {
          certificate_chain: { filename: '/etc/envoy/ca/leaf-cert.pem' },
          private_key: { filename: '/etc/envoy/ca/leaf-key.pem' },
        },
      );

      const hcm = mcpChain.filters[0].typed_config;
      expect(hcm.access_log[0].typed_config.log_format.text_format_source.inline_string).toContain(
        'CFGM|mcp|',
      );
      expect(hcm.route_config.virtual_hosts[0].routes[0].route.cluster).toBe(
        'cluster_mcp_filesystem_internal',
      );
      expect(hcm.route_config.virtual_hosts[0].routes[0].route.timeout).toBe('0s');
      expect(hcm.http_filters.map((f: any) => f.name)).toEqual(['envoy.filters.http.router']);

      const cluster = config.static_resources.clusters.find(
        (c: any) => c.name === 'cluster_mcp_filesystem_internal',
      );
      expect(
        cluster.load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address,
      ).toEqual({ address: 'host.docker.internal', port_value: 54321 });
      expect(cluster.transport_socket).toBeUndefined();
    });

    it('omits MCP chains and clusters when no MCP servers are declared', () => {
      const config = generateEnvoyConfig(allowlist) as any;
      const listener443 = config.static_resources.listeners.find(
        (l: any) => l.name === 'listener_443',
      );
      expect(
        listener443.filter_chains.some((fc: any) =>
          fc.filter_chain_match?.server_names?.[0]?.endsWith('.internal'),
        ),
      ).toBe(false);
    });
  });
});

describe('proxy policy block-list and skip-allow-list routing', () => {
  it('adds explicit block-list chains and HTTP vhosts', () => {
    const config = generateEnvoyConfig({
      ...allowlist,
      blocked: ['blocked.example.com', '*.blocked-wild.com'],
    }) as any;
    const listener443 = config.static_resources.listeners.find(
      (l: any) => l.name === 'listener_443',
    );
    const chain = listener443.filter_chains.find((fc: any) =>
      fc.filter_chain_match?.server_names?.includes('blocked.example.com'),
    );
    expect(chain).toBeDefined();
    expect(chain.filter_chain_match.server_names).toContain('*.blocked-wild.com');
    expect(chain.filters[0].typed_config.cluster).toBe('blackhole');
    expect(
      chain.filters[0].typed_config.access_log[0].typed_config.log_format.text_format_source
        .inline_string,
    ).toMatch(/^CFGM\|blocklist\|/);
    const listener80 = config.static_resources.listeners.find((l: any) => l.name === 'listener_80');
    const vhost =
      listener80.filter_chains[0].filters[0].typed_config.route_config.virtual_hosts.find(
        (v: any) => v.domains.includes('blocked.example.com'),
      );
    expect(vhost.routes[0]).toMatchObject({ name: 'blocked', direct_response: { status: 403 } });
  });

  it('opens the default branches under skip-allow-list while preserving block-list denial', () => {
    const config = generateEnvoyConfig(
      { ...allowlist, blocked: ['blocked.example.com'] },
      { skipAllowList: true },
    ) as any;
    const listener443 = config.static_resources.listeners.find(
      (l: any) => l.name === 'listener_443',
    );
    expect(listener443.default_filter_chain.filters[1].typed_config.cluster).toBe(
      'dynamic_forward_proxy_cluster',
    );
    expect(
      listener443.default_filter_chain.filters[1].typed_config.access_log[0].typed_config.log_format
        .text_format_source.inline_string,
    ).toMatch(/^CFGM\|passopen\|/);
    const listener80 = config.static_resources.listeners.find((l: any) => l.name === 'listener_80');
    const hcm = listener80.filter_chains[0].filters[0].typed_config;
    expect(
      hcm.route_config.virtual_hosts.find((v: any) => v.domains.includes('*')).routes[0].name,
    ).toBe('open');
    expect(hcm.http_filters.map((f: any) => f.name)).toContain(
      'envoy.filters.http.dynamic_forward_proxy',
    );
  });

  it('does not emit an empty 443 passthrough chain', () => {
    const config = generateEnvoyConfig({
      passthrough: [],
      claudeAuthenticated: [],
      githubAuthenticated: [],
      codexAuthenticated: [],
      authCandidate: [],
      blocked: [],
      warnings: [],
    }) as any;
    const listener443 = config.static_resources.listeners.find(
      (l: any) => l.name === 'listener_443',
    );
    expect(
      listener443.filter_chains.some(
        (fc: any) => fc.filter_chain_match?.server_names?.length === 0,
      ),
    ).toBe(false);
  });
});
