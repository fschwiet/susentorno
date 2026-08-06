import { describe, it, expect } from 'vitest';
import { buildSshRunArgv, buildScpArgv } from '../../../src/guestSetup/remoteExec';

describe('buildSshRunArgv', () => {
  it('wraps the command in bash -ic with -t and the quoted command as one argv element', () => {
    const argv = buildSshRunArgv({ address: '192.168.1.50', username: 'ubuntu' }, 'echo hi');
    expect(argv).toEqual(['-t', 'ubuntu@192.168.1.50', 'bash', '-ic', "'echo hi'"]);
  });

  it('escapes a single quote inside the command', () => {
    const argv = buildSshRunArgv({ address: 'host', username: 'ubuntu' }, "echo 'hi'");
    expect(argv[4]).toBe("'echo '\\''hi'\\'''");
  });
});

describe('buildScpArgv', () => {
  it('builds a local-path to user@host:remote-path argv', () => {
    const argv = buildScpArgv(
      { address: '192.168.1.50', username: 'ubuntu' },
      '/tmp/local-file',
      '/tmp/remote-file',
    );
    expect(argv).toEqual(['/tmp/local-file', 'ubuntu@192.168.1.50:/tmp/remote-file']);
  });
});
