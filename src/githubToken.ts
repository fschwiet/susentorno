const TOKEN_PREFIX = 'github_pat_';
const TOKEN_LENGTH = 93;

export function validateGithubTokenFormat(token: string): string | null {
  if (!token.startsWith(TOKEN_PREFIX)) {
    return `token must start with "${TOKEN_PREFIX}"`;
  }
  if (token.length !== TOKEN_LENGTH) {
    return `token must be ${TOKEN_LENGTH} characters long, got ${token.length}`;
  }
  const body = token.slice(TOKEN_PREFIX.length);
  if (!/^[A-Za-z0-9_]+$/.test(body)) {
    return 'token must contain only letters, digits, and underscores after the prefix';
  }
  return null;
}
