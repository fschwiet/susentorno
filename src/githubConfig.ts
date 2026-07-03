export interface GithubConfig {
  username: string;
  email: string;
  token: string;
}

export function formatGithubConfig(config: GithubConfig): string {
  return [
    `GITHUB_USERNAME="${config.username}"`,
    `GITHUB_EMAIL="${config.email}"`,
    `GITHUB_TOKEN="${config.token}"`,
    '',
  ].join('\n');
}
