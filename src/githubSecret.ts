/**
 * Render the two Envoy file-based SDS secrets consumed from
 * .configamatron/proxy/secrets/. Each file carries exactly one resource:
 * Envoy's filesystem SDS rejects a watched file that holds more than the one
 * resource a given sds_config subscription expects. `github_basic_auth`
 * (git's Basic auth to github.com) and `github_api_token` (gh's Bearer auth
 * to api.github.com) are therefore two separate files, both derived from one PAT.
 */
export function formatGithubBasicSecret(username: string, token: string): string {
  const basic = 'Basic ' + Buffer.from(`${username}:${token}`).toString('base64');
  return [
    'resources:',
    '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
    '    name: github_basic_auth',
    '    generic_secret:',
    '      secret:',
    `        inline_string: "${basic}"`,
    '',
  ].join('\n');
}

export function formatGithubApiTokenSecret(token: string): string {
  return [
    'resources:',
    '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
    '    name: github_api_token',
    '    generic_secret:',
    '      secret:',
    `        inline_string: "Bearer ${token}"`,
    '',
  ].join('\n');
}
