import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { promptText, promptMasked } from '../../src/cliPrompt';

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => {
    written += chunk.toString();
  });
  return { input, output, written: () => written };
}

describe('promptText', () => {
  it('returns the typed value', async () => {
    const s = streams();
    const result = promptText('Guest address', undefined, s);
    s.input.write('192.168.1.50\n');
    expect(await result).toBe('192.168.1.50');
  });

  it('returns the default when Enter is pressed with no input', async () => {
    const s = streams();
    const result = promptText('SMB share name', 'vm-shared-linux', s);
    s.input.write('\n');
    expect(await result).toBe('vm-shared-linux');
  });

  it('prints the default in the prompt text', async () => {
    const s = streams();
    const result = promptText('SMB share name', 'vm-shared-linux', s);
    s.input.write('\n');
    await result;
    expect(s.written()).toContain('vm-shared-linux');
  });
});

describe('promptMasked', () => {
  it('resolves with the typed value', async () => {
    const s = streams();
    const result = promptMasked('SMB share password', s);
    s.input.write('hunter2');
    s.input.write('\r');
    expect(await result).toBe('hunter2');
  });

  it('echoes asterisks instead of the typed characters', async () => {
    const s = streams();
    const result = promptMasked('SMB share password', s);
    s.input.write('hunter2');
    s.input.write('\r');
    await result;
    expect(s.written()).toContain('*******');
    expect(s.written()).not.toContain('hunter2');
  });

  it('handles backspace by removing the last character', async () => {
    const s = streams();
    const result = promptMasked('SMB share password', s);
    s.input.write('hunterX');
    s.input.write('\x7f'); // backspace
    s.input.write('2');
    s.input.write('\r');
    expect(await result).toBe('hunter2');
  });
});
