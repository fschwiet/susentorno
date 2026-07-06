import { describe, it, expect } from 'vitest';
import { generateEnvoyConfig } from '../../src/envoyConfig';
import type { Allowlist } from '../../src/allowlist';

const allowlist: Allowlist = {
  passthrough: ['**.chatgpt.com:443', 'archive.ubuntu.com:80'],
  terminate: ['api.anthropic.com:443'],
};

describe('generateEnvoyConfig', () => {
  it('builds a terminate filter chain and cluster for each terminate host', () => {
    const config = generateEnvoyConfig(allowlist) as any;
    const listener443 = config.static_resources.listeners.find(
      (l: any) => l.name === 'listener_443',
    );
    const terminateChain = listener443.filter_chains.find((fc: any) =>
      fc.filter_chain_match?.server_names?.includes('api.anthropic.com'),
    );

    expect(terminateChain).toBeDefined();
    const hcm = terminateChain.filters[0].typed_config;
    expect(hcm['@type']).toBe(
      'type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager',
    );
    expect(hcm.route_config.virtual_hosts[0].routes[0].route.cluster).toBe(
      'cluster_terminate_api_anthropic_com',
    );
    expect(hcm.http_filters.map((f: any) => f.name)).toEqual([
      'envoy.filters.http.lua',
      'envoy.filters.http.credential_injector',
      'envoy.filters.http.router',
    ]);

    const cluster = config.static_resources.clusters.find(
      (c: any) => c.name === 'cluster_terminate_api_anthropic_com',
    );
    expect(
      cluster.load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address,
    ).toEqual({ address: 'api.anthropic.com', port_value: 443 });
    expect(cluster.transport_socket.typed_config['@type']).toBe(
      'type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext',
    );
  });

  it('redirects a terminate cluster to the override target and disables upstream cert validation', () => {
    const config = generateEnvoyConfig(allowlist, {
      overrides: [{ sniHost: 'api.anthropic.com', target: '127.0.0.1:9443' }],
    }) as any;

    const cluster = config.static_resources.clusters.find(
      (c: any) => c.name === 'cluster_terminate_api_anthropic_com',
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
    expect(termLog.typed_config.log_format.text_format_source.inline_string).toMatch(/^CFGM\|term\|/);

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
