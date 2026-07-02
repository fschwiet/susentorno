import type { Allowlist } from './allowlist';

export interface UpstreamOverride {
  sniHost: string;
  target: string;
}

export interface BuildEnvoyConfigOptions {
  overrides?: UpstreamOverride[];
}

function sanitizeName(host: string): string {
  return host.replace(/[^a-zA-Z0-9]/g, '_');
}

function toEnvoyWildcard(host: string): string {
  return host.startsWith('**.') ? `*.${host.slice(3)}` : host;
}

function buildTerminateEntry(entry: string, overrides: UpstreamOverride[]) {
  const [sniHost, portStr] = entry.split(':');
  const override = overrides.find((o) => o.sniHost === sniHost);
  const [upstreamHost, upstreamPortStr] = override
    ? override.target.split(':')
    : [sniHost, portStr];
  const clusterName = `cluster_terminate_${sanitizeName(sniHost)}`;

  const filterChain = {
    filter_chain_match: { server_names: [sniHost] },
    transport_socket: {
      name: 'envoy.transport_sockets.tls',
      typed_config: {
        '@type':
          'type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext',
        common_tls_context: {
          tls_certificates: [
            {
              certificate_chain: { filename: '/etc/envoy/ca/cert.pem' },
              private_key: { filename: '/etc/envoy/ca/key.pem' },
            },
          ],
        },
      },
    },
    filters: [
      {
        name: 'envoy.filters.network.http_connection_manager',
        typed_config: {
          '@type':
            'type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager',
          stat_prefix: `terminate_${sanitizeName(sniHost)}`,
          route_config: {
            name: 'local_route',
            virtual_hosts: [
              {
                name: 'terminate',
                domains: ['*'],
                routes: [{ match: { prefix: '/' }, route: { cluster: clusterName } }],
              },
            ],
          },
          http_filters: [
            {
              name: 'envoy.filters.http.lua',
              typed_config: {
                '@type': 'type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua',
                default_source_code: { filename: '/etc/envoy/gate.lua' },
              },
            },
            {
              name: 'envoy.filters.http.credential_injector',
              typed_config: {
                '@type':
                  'type.googleapis.com/envoy.extensions.filters.http.credential_injector.v3.CredentialInjector',
                overwrite: true,
                credential: {
                  name: 'envoy.http.injected_credentials.generic',
                  typed_config: {
                    '@type':
                      'type.googleapis.com/envoy.extensions.http.injected_credentials.generic.v3.Generic',
                    header: 'Authorization',
                    credential: {
                      name: 'sandbox_bearer_token',
                      sds_config: {
                        path_config_source: {
                          path: '/etc/envoy/secrets/sds-secret.yaml',
                          watched_directory: { path: '/etc/envoy/secrets' },
                        },
                        resource_api_version: 'V3',
                      },
                    },
                  },
                },
              },
            },
            {
              name: 'envoy.filters.http.router',
              typed_config: {
                '@type': 'type.googleapis.com/envoy.extensions.filters.http.router.v3.Router',
              },
            },
          ],
        },
      },
    ],
  };

  const cluster = {
    name: clusterName,
    type: 'STRICT_DNS',
    lb_policy: 'ROUND_ROBIN',
    load_assignment: {
      cluster_name: clusterName,
      endpoints: [
        {
          lb_endpoints: [
            {
              endpoint: {
                address: {
                  socket_address: { address: upstreamHost, port_value: Number(upstreamPortStr) },
                },
              },
            },
          ],
        },
      ],
    },
    transport_socket: {
      name: 'envoy.transport_sockets.tls',
      typed_config: {
        '@type': 'type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext',
        sni: sniHost,
        common_tls_context: override
          ? { validation_context: { trust_chain_verification: 'ACCEPT_UNTRUSTED' } }
          : {},
      },
    },
  };

  return { filterChain, cluster };
}

function buildHttp80Entry(entry: string) {
  const [host, portStr] = entry.split(':');
  const clusterName = `cluster_http_${sanitizeName(host)}`;

  const virtualHost = {
    name: sanitizeName(host),
    domains: [host],
    routes: [{ match: { prefix: '/' }, route: { cluster: clusterName } }],
  };

  const cluster = {
    name: clusterName,
    type: 'STRICT_DNS',
    lb_policy: 'ROUND_ROBIN',
    load_assignment: {
      cluster_name: clusterName,
      endpoints: [
        {
          lb_endpoints: [
            {
              endpoint: {
                address: { socket_address: { address: host, port_value: Number(portStr) } },
              },
            },
          ],
        },
      ],
    },
  };

  return { virtualHost, cluster };
}

export function generateEnvoyConfig(
  allowlist: Allowlist,
  options: BuildEnvoyConfigOptions = {},
): Record<string, unknown> {
  const overrides = options.overrides ?? [];

  const terminateBuilt = allowlist.terminate
    .filter((e) => e.endsWith(':443'))
    .map((e) => buildTerminateEntry(e, overrides));
  const passthroughServerNames = allowlist.passthrough
    .filter((e) => e.endsWith(':443'))
    .map((e) => toEnvoyWildcard(e.split(':')[0]));
  const http80Built = allowlist.passthrough.filter((e) => e.endsWith(':80')).map(buildHttp80Entry);

  return {
    admin: {
      address: { socket_address: { address: '0.0.0.0', port_value: 9901 } },
    },
    static_resources: {
      listeners: [
        {
          name: 'listener_443',
          address: { socket_address: { address: '0.0.0.0', port_value: 443 } },
          listener_filters: [
            {
              name: 'envoy.filters.listener.tls_inspector',
              typed_config: {
                '@type':
                  'type.googleapis.com/envoy.extensions.filters.listener.tls_inspector.v3.TlsInspector',
              },
            },
          ],
          filter_chains: [
            ...terminateBuilt.map((b) => b.filterChain),
            {
              filter_chain_match: { server_names: passthroughServerNames },
              filters: [
                {
                  name: 'envoy.filters.network.sni_dynamic_forward_proxy',
                  typed_config: {
                    '@type':
                      'type.googleapis.com/envoy.extensions.filters.network.sni_dynamic_forward_proxy.v3.FilterConfig',
                    port_value: 443,
                    dns_cache_config: {
                      name: 'dynamic_forward_proxy_cache_config',
                      dns_lookup_family: 'V4_ONLY',
                    },
                  },
                },
                {
                  name: 'envoy.filters.network.tcp_proxy',
                  typed_config: {
                    '@type':
                      'type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy',
                    stat_prefix: 'passthrough_443',
                    cluster: 'dynamic_forward_proxy_cluster',
                  },
                },
              ],
            },
          ],
        },
        {
          name: 'listener_80',
          address: { socket_address: { address: '0.0.0.0', port_value: 80 } },
          filter_chains: [
            {
              filters: [
                {
                  name: 'envoy.filters.network.http_connection_manager',
                  typed_config: {
                    '@type':
                      'type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager',
                    stat_prefix: 'passthrough_80',
                    route_config: {
                      name: 'local_route_80',
                      virtual_hosts: [
                        ...http80Built.map((b) => b.virtualHost),
                        {
                          name: 'default_deny',
                          domains: ['*'],
                          routes: [
                            {
                              match: { prefix: '/' },
                              direct_response: {
                                status: 403,
                                body: { inline_string: 'sandbox: host not allow-listed' },
                              },
                            },
                          ],
                        },
                      ],
                    },
                    http_filters: [
                      {
                        name: 'envoy.filters.http.router',
                        typed_config: {
                          '@type':
                            'type.googleapis.com/envoy.extensions.filters.http.router.v3.Router',
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
      clusters: [
        ...terminateBuilt.map((b) => b.cluster),
        ...http80Built.map((b) => b.cluster),
        {
          name: 'dynamic_forward_proxy_cluster',
          lb_policy: 'CLUSTER_PROVIDED',
          cluster_type: {
            name: 'envoy.clusters.dynamic_forward_proxy',
            typed_config: {
              '@type':
                'type.googleapis.com/envoy.extensions.clusters.dynamic_forward_proxy.v3.ClusterConfig',
              dns_cache_config: {
                name: 'dynamic_forward_proxy_cache_config',
                dns_lookup_family: 'V4_ONLY',
              },
            },
          },
        },
      ],
    },
  };
}
