import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { promptText, promptMasked, PromptEndedError } from '../../src/cliPrompt';

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

  it('pauses the input stream after resolving, so a later spawned child can read the console', async () => {
    const s = streams();
    const pauseSpy = vi.spyOn(s.input, 'pause');
    const result = promptMasked('SMB share password', s);
    s.input.write('hunter2');
    s.input.write('\r');
    await result;
    expect(pauseSpy).toHaveBeenCalled();
  });

  it('pauses the input stream after a cancellation (Ctrl+C)', async () => {
    const s = streams();
    const pauseSpy = vi.spyOn(s.input, 'pause');
    const result = promptMasked('SMB share password', s);
    s.input.write('\x03');
    await expect(result).rejects.toThrow('promptMasked: cancelled');
    expect(pauseSpy).toHaveBeenCalled();
  });
});

describe('prompt input that ends before an answer', () => {
  it('promptText rejects with a typed PromptEndedError when input reaches EOF', async () => {
    const s = streams();
    const result = promptText('Hyper-V VM name', undefined, s);
    s.input.end();
    await expect(result).rejects.toBeInstanceOf(PromptEndedError);
    await expect(result).rejects.toMatchObject({ reason: 'eof', question: 'Hyper-V VM name' });
  });

  it('promptText still returns a final line that has no trailing newline before EOF', async () => {
    const s = streams();
    const result = promptText('Hyper-V VM name', undefined, s);
    s.input.end('my-vm\n');
    expect(await result).toBe('my-vm');
  });

  it('promptText rejects when the input had already ended before the prompt was asked', async () => {
    const s = streams();
    s.input.resume();
    s.input.end();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(promptText('Guest username', undefined, s)).rejects.toMatchObject({
      reason: 'eof',
      question: 'Guest username',
    });
  });

  it('promptMasked rejects when the input had already ended before the prompt was asked', async () => {
    const s = streams();
    s.input.resume();
    s.input.end();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(promptMasked('Guest password', s)).rejects.toMatchObject({ reason: 'eof' });
  });

  it('a second prompt after piped input that ended with the first answer ends the same way', async () => {
    const s = streams();
    const first = promptMasked('Guest password', s);
    s.input.end('hunter2' + String.fromCharCode(13));
    expect(await first).toBe('hunter2');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(promptText('Guest username', undefined, s)).rejects.toBeInstanceOf(
      PromptEndedError,
    );
  });

  it('promptMasked rejects with a typed PromptEndedError on EOF with nothing typed', async () => {
    const s = streams();
    const pauseSpy = vi.spyOn(s.input, 'pause');
    const result = promptMasked('Guest password', s);
    s.input.end();
    await expect(result).rejects.toMatchObject({ reason: 'eof', question: 'Guest password' });
    expect(pauseSpy).toHaveBeenCalled();
  });

  it('promptMasked accepts a piped value with no trailing newline at EOF', async () => {
    const s = streams();
    const result = promptMasked('Guest password', s);
    s.input.end('hunter2');
    expect(await result).toBe('hunter2');
  });

  it('promptMasked reports Ctrl+C as a cancelled PromptEndedError with the existing message', async () => {
    const s = streams();
    const result = promptMasked('Guest password', s);
    s.input.write('\x03');
    await expect(result).rejects.toMatchObject({
      reason: 'cancelled',
      message: 'promptMasked: cancelled',
    });
  });
});
