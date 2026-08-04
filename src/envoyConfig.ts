import type { Allowlist } from './allowlist';
import { GITHUB_PLACEHOLDER_PAT } from './githubPlaceholder';
import { CODEX_PLACEHOLDER_ACCESS_TOKEN } from './codexPlaceholder';

export interface UpstreamOverride {
  sniHost: string;
  target: string;
}

/**
 * Proxy-internal marker header. A pre-filter sets it (alongside a sentinel
 * `Authorization` value) only when the client sent no Authorization header at all,
 * so the credential_injector (overwrite:false) sees a header present and skips
 * injecting. The shared post-filter strips both back off before the router. Every
 * pre-filter must remove any inbound copy of this header first — it must never be
 * something a client-sent request can forge.
 */
export const NO_AUTH_MARKER_HEADER = 'x-susentorno-no-auth';

/** Placeholder Authorization value used only to make the header non-absent for the
 * injector's benefit; its content is never inspected — only NO_AUTH_MARKER_HEADER
 * controls whether the post-filter strips it. */
export const NO_AUTH_SENTINEL_VALUE = 'susentorno-no-credential';

// Shared by every authenticated chain (Claude, Codex, both GitHub gates): runs after
// credential_injector to undo the marker/sentinel a pre-filter sets for a genuinely
// absent Authorization header, so "no credential sent" reaches the real upstream as
// absent rather than as the sentinel. Host-agnostic — never inspects any placeholder.
export const AUTH_POST_FILTER_LUA = `local NO_AUTH_MARKER = "${NO_AUTH_MARKER_HEADER}"

function envoy_on_request(request_handle)
  local headers = request_handle:headers()
  if headers:get(NO_AUTH_MARKER) ~= nil then
    headers:remove(NO_AUTH_MARKER)
    headers:remove("authorization")
  end
end
`;

/** Test-only config faults, applied as render-time mutations of envoy.yaml. */
export type InjectFault = 'crash-config' | 'never-ready';

export interface McpServerUpstream {
  hostname: string;
  port: number;
}

export interface BuildEnvoyConfigOptions {
  overrides?: UpstreamOverride[];
  /**
   * Test-only. `crash-config` sets the admin port out of range so Envoy rejects
   * the bootstrap and exits; `never-ready` moves admin off container port 9901
   * so Envoy stays healthy but the admin probe is refused forever.
   */
  fault?: InjectFault;
  mcpServers?: McpServerUpstream[];
  skipAllowList?: boolean;
}

function sanitizeName(host: string): string {
  return host.replace(/[^a-zA-Z0-9]/g, '_');
}

function accessLog(pathId: string): Record<string, unknown>[] {
  return [
    {
      name: 'envoy.access_loggers.file',
      typed_config: {
        '@type': 'type.googleapis.com/envoy.extensions.access_loggers.file.v3.FileAccessLog',
        path: '/dev/stdout',
        log_format: {
          text_format_source: {
            inline_string:
              `CFGM|${pathId}|%START_TIME(%Y-%m-%dT%H:%M:%S)%|%REQUESTED_SERVER_NAME%|` +
              `%REQ(:AUTHORITY)%|%RESPONSE_CODE_DETAILS%|%RESPONSE_CODE%|%RESPONSE_FLAGS%|` +
              `%DURATION%|%BYTES_SENT%\n`,
          },
        },
      },
    },
  ];
}

function buildTlsUpstreamCluster(
  clusterName: string,
  sniHost: string,
  portStr: string,
  override: UpstreamOverride | undefined,
) {
  const [upstreamHost, upstreamPortStr] = override
    ? override.target.split(':')
    : [sniHost, portStr];
  return {
    name: clusterName,
    type: 'STRICT_DNS',
    dns_lookup_family: 'V4_ONLY',
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
}

function authCandidateAccessLog(): Record<string, unknown>[] {
  return [
    {
      name: 'envoy.access_loggers.file',
      typed_config: {
        '@type': 'type.googleapis.com/envoy.extensions.access_loggers.file.v3.FileAccessLog',
        path: '/dev/stdout',
        log_format: {
          text_format_source: {
            inline_string:
              'CFGM|cand|%START_TIME(%Y-%m-%dT%H:%M:%S)%|%REQUESTED_SERVER_NAME%|' +
              '%REQ(:AUTHORITY)%|%RESPONSE_CODE_DETAILS%|%REQ(AUTHORIZATION):12%|' +
              '%REQ(COOKIE):12%|%REQ(X-API-KEY):12%|%REQ(X-AUTH-TOKEN):12%|' +
              '%REQ(PROXY-AUTHORIZATION):12%\n',
          },
        },
      },
    },
  ];
}

function buildAuthCandidateEntry(entry: string, overrides: UpstreamOverride[]) {
  const [sniHost, portStr] = entry.split(':');
  const override = overrides.find((o) => o.sniHost === sniHost);
  const clusterName = `cluster_authcandidate_${sanitizeName(sniHost)}`;

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
              certificate_chain: { filename: '/etc/envoy/ca/leaf-cert.pem' },
              private_key: { filename: '/etc/envoy/ca/leaf-key.pem' },
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
          stat_prefix: `authcandidate_${sanitizeName(sniHost)}`,
          access_log: authCandidateAccessLog(),
          route_config: {
            name: 'local_route',
            virtual_hosts: [
              {
                name: 'authcandidate',
                domains: ['*'],
                // timeout '0s' matches the claude path: don't sever long
                // streaming responses at Envoy's default 15s route timeout.
                routes: [
                  { match: { prefix: '/' }, route: { cluster: clusterName, timeout: '0s' } },
                ],
              },
            ],
          },
          // No lua gate and no credential_injector: the point is to observe the
          // client's own auth untouched, not to reject or replace it.
          http_filters: [
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

  const cluster = buildTlsUpstreamCluster(clusterName, sniHost, portStr, override);
  return { filterChain, cluster };
}

// api.github.com: exact-match gate accepting either the classic `token` scheme (what
// gh actually sends today, confirmed by wire capture) or `Bearer` (GitHub's documented
// alternative, in case a future gh version switches — see cli/cli#12828, currently
// unshipped). Same overall shape as templates/proxy/gate.lua, just two accepted
// placeholder strings instead of one.
const GITHUB_API_TOKEN_GATE_LUA = `local TOKEN_PLACEHOLDER = "token ${GITHUB_PLACEHOLDER_PAT}"
local BEARER_PLACEHOLDER = "Bearer ${GITHUB_PLACEHOLDER_PAT}"
local NO_AUTH_MARKER = "${NO_AUTH_MARKER_HEADER}"
local NO_AUTH_SENTINEL = "${NO_AUTH_SENTINEL_VALUE}"

function envoy_on_request(request_handle)
  local headers = request_handle:headers()
  headers:remove(NO_AUTH_MARKER)
  local auth = headers:get("authorization")
  if auth == nil then
    headers:replace("authorization", NO_AUTH_SENTINEL)
    headers:replace(NO_AUTH_MARKER, "1")
    return
  end
  if auth == TOKEN_PLACEHOLDER or auth == BEARER_PLACEHOLDER then
    headers:remove("authorization")
  end
end
`;

// github.com: git sends Basic base64(<login>:<PAT>). The login is chosen by gh's
// credential helper and unknown at config time, so this gate decodes the credential
// and checks ONLY the password half against the placeholder PAT, ignoring the user.
// Envoy's Lua has no base64 decoder, so one is embedded inline.
const GITHUB_BASIC_GATE_LUA = `local PLACEHOLDER_PAT = "${GITHUB_PLACEHOLDER_PAT}"
local NO_AUTH_MARKER = "${NO_AUTH_MARKER_HEADER}"
local NO_AUTH_SENTINEL = "${NO_AUTH_SENTINEL_VALUE}"
local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

local function b64decode(data)
  if #data % 4 ~= 0 or string.match(data, "[^" .. B64 .. "=]") then
    return nil
  end
  data = string.gsub(data, "=", "")
  local bits = string.gsub(data, ".", function(c)
    local f = B64:find(c, 1, true) - 1
    local r = ""
    for i = 6, 1, -1 do
      r = r .. (f % (2 ^ i) - f % (2 ^ (i - 1)) > 0 and "1" or "0")
    end
    return r
  end)
  return (string.gsub(bits, "%d%d%d?%d?%d?%d?%d?%d?", function(x)
    if #x ~= 8 then
      return ""
    end
    local c = 0
    for i = 1, 8 do
      c = c + (x:sub(i, i) == "1" and 2 ^ (8 - i) or 0)
    end
    return string.char(c)
  end))
end

function envoy_on_request(request_handle)
  local headers = request_handle:headers()
  headers:remove(NO_AUTH_MARKER)
  local auth = headers:get("authorization")
  if auth == nil then
    headers:replace("authorization", NO_AUTH_SENTINEL)
    headers:replace(NO_AUTH_MARKER, "1")
    return
  end
  local encoded = string.match(auth, "^Basic (.+)$")
  if encoded == nil then
    return
  end
  local decoded = b64decode(encoded)
  if decoded == nil then
    return
  end
  local password = string.match(decoded, "^[^:]*:(.*)$")
  if password == PLACEHOLDER_PAT then
    headers:remove("authorization")
  end
end
`;

// github.com -> Basic gate + github_basic_auth; api.github.com -> token/Bearer gate + github_api_token.
// Each SDS resource lives in its own watched file: Envoy's filesystem SDS rejects a
// watched file that holds more than the one resource a given sds_config expects.
const GITHUB_INJECTION: Record<string, { sdsResource: string; sdsFile: string; gate: string }> = {
  'github.com': {
    sdsResource: 'github_basic_auth',
    sdsFile: 'github-basic-secret.yaml',
    gate: GITHUB_BASIC_GATE_LUA,
  },
  'api.github.com': {
    sdsResource: 'github_api_token',
    sdsFile: 'github-api-token-secret.yaml',
    gate: GITHUB_API_TOKEN_GATE_LUA,
  },
};

function buildGithubEntry(
  entry: string,
  overrides: UpstreamOverride[],
  sdsResource: string,
  sdsFile: string,
  gateSource: string,
) {
  const [sniHost, portStr] = entry.split(':');
  const override = overrides.find((o) => o.sniHost === sniHost);
  const clusterName = `cluster_github_${sanitizeName(sniHost)}`;

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
              certificate_chain: { filename: '/etc/envoy/ca/leaf-cert.pem' },
              private_key: { filename: '/etc/envoy/ca/leaf-key.pem' },
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
          stat_prefix: `github_${sanitizeName(sniHost)}`,
          // Reuse the 'term' access-log tag: github chains are credential-injected
          // TLS-terminating chains, so they classify as ALLOW CRED like the Claude hosts.
          access_log: accessLog('term'),
          route_config: {
            name: 'local_route',
            virtual_hosts: [
              {
                name: 'github',
                domains: ['*'],
                routes: [
                  { match: { prefix: '/' }, route: { cluster: clusterName, timeout: '0s' } },
                ],
              },
            ],
          },
          http_filters: [
            {
              name: 'susentorno.auth_pre',
              typed_config: {
                '@type': 'type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua',
                default_source_code: { inline_string: gateSource },
              },
            },
            {
              name: 'envoy.filters.http.credential_injector',
              typed_config: {
                '@type':
                  'type.googleapis.com/envoy.extensions.filters.http.credential_injector.v3.CredentialInjector',
                overwrite: false,
                credential: {
                  name: 'envoy.http.injected_credentials.generic',
                  typed_config: {
                    '@type':
                      'type.googleapis.com/envoy.extensions.http.injected_credentials.generic.v3.Generic',
                    header: 'Authorization',
                    credential: {
                      name: sdsResource,
                      sds_config: {
                        path_config_source: {
                          path: `/etc/envoy/secrets/${sdsFile}`,
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
              name: 'susentorno.auth_post',
              typed_config: {
                '@type': 'type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua',
                default_source_code: { inline_string: AUTH_POST_FILTER_LUA },
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

  const cluster = buildTlsUpstreamCluster(clusterName, sniHost, portStr, override);

  return { filterChain, cluster };
}

function buildClaudeEntry(entry: string, overrides: UpstreamOverride[]) {
  const [sniHost, portStr] = entry.split(':');
  const override = overrides.find((o) => o.sniHost === sniHost);
  const clusterName = `cluster_claude_${sanitizeName(sniHost)}`;

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
              certificate_chain: { filename: '/etc/envoy/ca/leaf-cert.pem' },
              private_key: { filename: '/etc/envoy/ca/leaf-key.pem' },
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
          stat_prefix: `claude_${sanitizeName(sniHost)}`,
          access_log: accessLog('term'),
          route_config: {
            name: 'local_route',
            virtual_hosts: [
              {
                name: 'claude',
                domains: ['*'],
                routes: [
                  {
                    match: { prefix: '/' },
                    // timeout: 0 disables Envoy's default 15s route timeout, which
                    // otherwise caps the *entire* response and severs long streaming
                    // (SSE) replies from api.anthropic.com mid-response once they run
                    // past 15s. stream_idle_timeout (5m default) still reaps genuinely
                    // dead streams; Anthropic's periodic SSE pings keep live ones fresh.
                    route: { cluster: clusterName, timeout: '0s' },
                  },
                ],
              },
            ],
          },
          http_filters: [
            {
              name: 'susentorno.auth_pre',
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
                overwrite: false,
                credential: {
                  name: 'envoy.http.injected_credentials.generic',
                  typed_config: {
                    '@type':
                      'type.googleapis.com/envoy.extensions.http.injected_credentials.generic.v3.Generic',
                    header: 'Authorization',
                    credential: {
                      name: 'susentorno_bearer_token',
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
              name: 'susentorno.auth_post',
              typed_config: {
                '@type': 'type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua',
                default_source_code: { inline_string: AUTH_POST_FILTER_LUA },
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

  const cluster = buildTlsUpstreamCluster(clusterName, sniHost, portStr, override);

  return { filterChain, cluster };
}

// chatgpt.com: exact-match gate accepting only the placeholder Bearer. Emitted inline
// (GitHub's precedent) so docker-compose.yml needs no new mounted gate file. Cookie is
// never read here, so it passes through untouched in both directions.
const CODEX_GATE_LUA = `local PLACEHOLDER = "Bearer ${CODEX_PLACEHOLDER_ACCESS_TOKEN}"
local NO_AUTH_MARKER = "${NO_AUTH_MARKER_HEADER}"
local NO_AUTH_SENTINEL = "${NO_AUTH_SENTINEL_VALUE}"

function envoy_on_request(request_handle)
  local headers = request_handle:headers()
  headers:remove(NO_AUTH_MARKER)
  local auth = headers:get("authorization")
  if auth == nil then
    headers:replace("authorization", NO_AUTH_SENTINEL)
    headers:replace(NO_AUTH_MARKER, "1")
    return
  end
  if auth == PLACEHOLDER then
    headers:remove("authorization")
  end
end
`;

function buildCodexEntry(entry: string, overrides: UpstreamOverride[]) {
  const [sniHost, portStr] = entry.split(':');
  const override = overrides.find((o) => o.sniHost === sniHost);
  const clusterName = `cluster_codex_${sanitizeName(sniHost)}`;

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
              certificate_chain: { filename: '/etc/envoy/ca/leaf-cert.pem' },
              private_key: { filename: '/etc/envoy/ca/leaf-key.pem' },
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
          stat_prefix: `codex_${sanitizeName(sniHost)}`,
          access_log: accessLog('term'),
          // Codex prefers wss://chatgpt.com/backend-api/codex/responses; without this the
          // upgrade 403s at the HCM and Codex silently falls back to HTTPS. The gate and
          // injector still run on the upgrade request's headers.
          upgrade_configs: [{ upgrade_type: 'websocket' }],
          route_config: {
            name: 'local_route',
            virtual_hosts: [
              {
                name: 'codex',
                domains: ['*'],
                routes: [
                  { match: { prefix: '/' }, route: { cluster: clusterName, timeout: '0s' } },
                ],
              },
            ],
          },
          http_filters: [
            {
              name: 'susentorno.auth_pre',
              typed_config: {
                '@type': 'type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua',
                default_source_code: { inline_string: CODEX_GATE_LUA },
              },
            },
            {
              name: 'envoy.filters.http.credential_injector',
              typed_config: {
                '@type':
                  'type.googleapis.com/envoy.extensions.filters.http.credential_injector.v3.CredentialInjector',
                overwrite: false,
                credential: {
                  name: 'envoy.http.injected_credentials.generic',
                  typed_config: {
                    '@type':
                      'type.googleapis.com/envoy.extensions.http.injected_credentials.generic.v3.Generic',
                    header: 'Authorization',
                    credential: {
                      name: 'codex_bearer_token',
                      sds_config: {
                        path_config_source: {
                          path: '/etc/envoy/secrets/codex-secret.yaml',
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
              name: 'susentorno.auth_post',
              typed_config: {
                '@type': 'type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua',
                default_source_code: { inline_string: AUTH_POST_FILTER_LUA },
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

  const cluster = buildTlsUpstreamCluster(clusterName, sniHost, portStr, override);
  return { filterChain, cluster };
}

function buildMcpEntry(server: McpServerUpstream) {
  const clusterName = `cluster_mcp_${sanitizeName(server.hostname)}`;

  const filterChain = {
    filter_chain_match: { server_names: [server.hostname] },
    transport_socket: {
      name: 'envoy.transport_sockets.tls',
      typed_config: {
        '@type':
          'type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext',
        common_tls_context: {
          tls_certificates: [
            {
              certificate_chain: { filename: '/etc/envoy/ca/leaf-cert.pem' },
              private_key: { filename: '/etc/envoy/ca/leaf-key.pem' },
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
          stat_prefix: `mcp_${sanitizeName(server.hostname)}`,
          access_log: accessLog('mcp'),
          route_config: {
            name: 'local_route',
            virtual_hosts: [
              {
                name: 'mcp',
                domains: ['*'],
                routes: [
                  { match: { prefix: '/' }, route: { cluster: clusterName, timeout: '0s' } },
                ],
              },
            ],
          },
          // No auth_pre/credential_injector/auth_post: host-run MCP servers have no
          // auth of any form — network isolation is the only gate (see ADR host-run-mcp-servers).
          http_filters: [
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

  // Envoy runs inside the Docker container, so `127.0.0.1` here would be the
  // container's own loopback. host.docker.internal reaches the host, where the
  // spawned MCP server actually bound 127.0.0.1 (declared in docker-compose.yml's
  // `extra_hosts: host.docker.internal:host-gateway`). No transport_socket: cleartext
  // upstream, unlike every other terminated chain.
  const cluster = {
    name: clusterName,
    type: 'STRICT_DNS',
    dns_lookup_family: 'V4_ONLY',
    lb_policy: 'ROUND_ROBIN',
    load_assignment: {
      cluster_name: clusterName,
      endpoints: [
        {
          lb_endpoints: [
            {
              endpoint: {
                address: {
                  socket_address: { address: 'host.docker.internal', port_value: server.port },
                },
              },
            },
          ],
        },
      ],
    },
  };

  return { filterChain, cluster };
}

const DYNAMIC_FORWARD_PROXY_HTTP_CACHE = 'dynamic_forward_proxy_cache_config_http';

function buildWildcardHttp80VirtualHost(hosts: string[]) {
  return {
    name: 'http_wildcard',
    domains: hosts,
    routes: [{ name: 'matched', match: { prefix: '/' }, route: { cluster: 'dynamic_forward_proxy_cluster_http' } }],
  };
}

function buildBlockedHttp80VirtualHost(hosts: string[]) {
  return {
    name: 'blocked',
    domains: hosts,
    routes: [{ name: 'blocked', match: { prefix: '/' }, direct_response: { status: 403, body: { inline_string: 'susentorno: host blocked' } } }],
  };
}

function http80AccessLog(): Record<string, unknown>[] {
  return [{
    name: 'envoy.access_loggers.file',
    typed_config: {
      '@type': 'type.googleapis.com/envoy.extensions.access_loggers.file.v3.FileAccessLog',
      path: '/dev/stdout',
      log_format: {
        text_format_source: {
          inline_string:
            'CFGM|http|%START_TIME(%Y-%m-%dT%H:%M:%S)%|%REQUESTED_SERVER_NAME%|' +
            '%REQ(:AUTHORITY)%|%RESPONSE_CODE_DETAILS%|%RESPONSE_CODE%|%RESPONSE_FLAGS%|' +
            '%DURATION%|%BYTES_SENT%|%ROUTE_NAME%\n',
        },
      },
    },
  }];
}

function buildDynamicForwardProxyHttpCluster() {
  return {
    name: 'dynamic_forward_proxy_cluster_http',
    lb_policy: 'CLUSTER_PROVIDED',
    cluster_type: {
      name: 'envoy.clusters.dynamic_forward_proxy',
      typed_config: {
        '@type':
          'type.googleapis.com/envoy.extensions.clusters.dynamic_forward_proxy.v3.ClusterConfig',
        dns_cache_config: {
          name: DYNAMIC_FORWARD_PROXY_HTTP_CACHE,
          dns_lookup_family: 'V4_ONLY',
        },
      },
    },
  };
}

function buildDynamicForwardProxyHttpFilter() {
  return {
    name: 'envoy.filters.http.dynamic_forward_proxy',
    typed_config: {
      '@type':
        'type.googleapis.com/envoy.extensions.filters.http.dynamic_forward_proxy.v3.FilterConfig',
      dns_cache_config: {
        name: DYNAMIC_FORWARD_PROXY_HTTP_CACHE,
        dns_lookup_family: 'V4_ONLY',
      },
    },
  };
}

function buildHttp80Entry(entry: string) {
  const [host, portStr] = entry.split(':');
  const clusterName = `cluster_http_${sanitizeName(host)}`;

  const virtualHost = {
    name: sanitizeName(host),
    domains: [host],
    routes: [{ name: 'matched', match: { prefix: '/' }, route: { cluster: clusterName } }],
  };

  const cluster = {
    name: clusterName,
    type: 'STRICT_DNS',
    dns_lookup_family: 'V4_ONLY',
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
  const skipAllowList = options.skipAllowList ?? false;
  const adminPortValue =
    options.fault === 'crash-config' ? 70000 : options.fault === 'never-ready' ? 9902 : 9901;

  const claudeBuilt = allowlist.claudeAuthenticated
    .filter((e) => e.endsWith(':443'))
    .map((e) => buildClaudeEntry(e, overrides));
  const codexBuilt = allowlist.codexAuthenticated
    .filter((e) => e.endsWith(':443'))
    .map((e) => buildCodexEntry(e, overrides));
  const authCandidateBuilt = allowlist.authCandidate
    .filter((e) => e.endsWith(':443'))
    .map((e) => buildAuthCandidateEntry(e, overrides));
  const githubBuilt = allowlist.githubAuthenticated
    .filter((e) => e.endsWith(':443'))
    .map((e) => {
      const host = e.split(':')[0];
      const cfg = GITHUB_INJECTION[host];
      return cfg ? buildGithubEntry(e, overrides, cfg.sdsResource, cfg.sdsFile, cfg.gate) : null;
    })
    .filter((b): b is NonNullable<typeof b> => b !== null);
  const mcpBuilt = (options.mcpServers ?? []).map(buildMcpEntry);
  const passthroughServerNames = allowlist.passthrough
    .filter((e) => e.endsWith(':443'))
    .map((e) => e.split(':')[0]);
  const http80Entries = allowlist.passthrough.filter((e) => e.endsWith(':80'));
  const http80ExactBuilt = http80Entries.filter((e) => !e.startsWith('*.')).map(buildHttp80Entry);
  const http80WildcardHosts = http80Entries
    .filter((e) => e.startsWith('*.'))
    .map((e) => e.split(':')[0]);
  const hasWildcardHttp80 = http80WildcardHosts.length > 0;
  const blockListHosts = allowlist.blocked;
  const hasBlockList = blockListHosts.length > 0;
  const needsHttpDynamicForwardProxy = hasWildcardHttp80 || skipAllowList;

  return {
    node: { id: 'susentorno-proxy', cluster: 'susentorno-proxy' },
    admin: {
      address: { socket_address: { address: '0.0.0.0', port_value: adminPortValue } },
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
            ...claudeBuilt.map((b) => b.filterChain),
            ...codexBuilt.map((b) => b.filterChain),
            ...authCandidateBuilt.map((b) => b.filterChain),
            ...githubBuilt.map((b) => b.filterChain),
            ...mcpBuilt.map((b) => b.filterChain),
            ...(passthroughServerNames.length > 0
              ? [{
                  filter_chain_match: { server_names: passthroughServerNames },
                  filters: [
                    {
                      name: 'envoy.filters.network.sni_dynamic_forward_proxy',
                      typed_config: {
                        '@type': 'type.googleapis.com/envoy.extensions.filters.network.sni_dynamic_forward_proxy.v3.FilterConfig',
                        port_value: 443,
                        dns_cache_config: { name: 'dynamic_forward_proxy_cache_config', dns_lookup_family: 'V4_ONLY' },
                      },
                    },
                    {
                      name: 'envoy.filters.network.tcp_proxy',
                      typed_config: {
                        '@type': 'type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy',
                        stat_prefix: 'passthrough_443', cluster: 'dynamic_forward_proxy_cluster', access_log: accessLog('pass'),
                      },
                    },
                  ],
                }]
              : []),
            ...(hasBlockList
              ? [{
                  filter_chain_match: { server_names: blockListHosts },
                  filters: [{
                    name: 'envoy.filters.network.tcp_proxy',
                    typed_config: {
                      '@type': 'type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy',
                      stat_prefix: 'blocklist_443', cluster: 'blackhole', access_log: accessLog('blocklist'),
                    },
                  }],
                }]
              : []),
          ],
          default_filter_chain: skipAllowList
            ? { filters: [
                { name: 'envoy.filters.network.sni_dynamic_forward_proxy', typed_config: {
                  '@type': 'type.googleapis.com/envoy.extensions.filters.network.sni_dynamic_forward_proxy.v3.FilterConfig',
                  port_value: 443, dns_cache_config: { name: 'dynamic_forward_proxy_cache_config', dns_lookup_family: 'V4_ONLY' },
                } },
                { name: 'envoy.filters.network.tcp_proxy', typed_config: {
                  '@type': 'type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy',
                  stat_prefix: 'open_443', cluster: 'dynamic_forward_proxy_cluster', access_log: accessLog('passopen'),
                } },
              ] }
            : { filters: [{ name: 'envoy.filters.network.tcp_proxy', typed_config: {
                '@type': 'type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy',
                stat_prefix: 'blocked_443', cluster: 'blackhole', access_log: accessLog('deny443'),
              } }] },
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
                    access_log: http80AccessLog(),
                    route_config: {
                      name: 'local_route_80',
                      virtual_hosts: [
                        ...http80ExactBuilt.map((b) => b.virtualHost),
                        ...(hasWildcardHttp80
                          ? [buildWildcardHttp80VirtualHost(http80WildcardHosts)]
                          : []),
                        ...(hasBlockList ? [buildBlockedHttp80VirtualHost(blockListHosts)] : []),
                        {
                          name: 'default_deny',
                          domains: ['*'],
                          routes: skipAllowList
                            ? [{ name: 'open', match: { prefix: '/' }, route: { cluster: 'dynamic_forward_proxy_cluster_http' } }]
                            : [{ name: 'default-deny', match: { prefix: '/' }, direct_response: { status: 403, body: { inline_string: 'susentorno: host not allow-listed' } } }],
                        },
                      ],
                    },
                    http_filters: [
                      ...(needsHttpDynamicForwardProxy ? [buildDynamicForwardProxyHttpFilter()] : []),
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
        ...claudeBuilt.map((b) => b.cluster),
        ...codexBuilt.map((b) => b.cluster),
        ...authCandidateBuilt.map((b) => b.cluster),
        ...githubBuilt.map((b) => b.cluster),
        ...mcpBuilt.map((b) => b.cluster),
        ...http80ExactBuilt.map((b) => b.cluster),
        ...(needsHttpDynamicForwardProxy ? [buildDynamicForwardProxyHttpCluster()] : []),
        {
          name: 'blackhole',
          type: 'STATIC',
          load_assignment: { cluster_name: 'blackhole', endpoints: [] },
        },
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
