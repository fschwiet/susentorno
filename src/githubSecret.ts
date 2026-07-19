/**
 * Render the Envoy file-based SDS secret consumed from
 * .configamatron/proxy/secrets/github-secret.yaml. It carries two resources:
 * `github_basic_auth` (git's Basic auth to github.com) and `github_api_token`
 * (gh's Bearer auth to api.github.com), both derived from one PAT.
 */
export function formatGithubSecret(username: string, token: string): string {
  const basic = 'Basic ' + Buffer.from(`${username}:${token}`).toString('base64');
  return [
    'resources:',
    '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
    '    name: github_basic_auth',
    '    generic_secret:',
    '      secret:',
    `        inline_string: "${basic}"`,
    '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
    '    name: github_api_token',
    '    generic_secret:',
    '      secret:',
    `        inline_string: "Bearer ${token}"`,
    '',
  ].join('\n');
}
