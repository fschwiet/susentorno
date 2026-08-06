import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';

export interface PromptStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

function defaultStreams(): PromptStreams {
  return { input: process.stdin, output: process.stdout };
}

export async function promptText(
  question: string,
  defaultValue?: string,
  streams: PromptStreams = defaultStreams(),
): Promise<string> {
  const rl = createInterface({ input: streams.input, output: streams.output });
  const suffix = defaultValue !== undefined ? ` [${defaultValue}]` : '';
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  rl.close();
  return answer === '' && defaultValue !== undefined ? defaultValue : answer;
}

interface Keypress {
  name?: string;
  ctrl?: boolean;
}

export function promptMasked(
  question: string,
  streams: PromptStreams = defaultStreams(),
): Promise<string> {
  return new Promise((resolve, reject) => {
    const { input, output } = streams;
    output.write(`${question}: `);
    let value = '';

    emitKeypressEvents(input as NodeJS.ReadStream);
    const ttyInput = input as NodeJS.ReadStream;
    const isTTY = ttyInput.isTTY === true;
    if (isTTY) ttyInput.setRawMode(true);

    const cleanup = () => {
      input.removeListener('keypress', onKeypress);
      if (isTTY) ttyInput.setRawMode(false);
    };

    function onKeypress(str: string | undefined, key: Keypress) {
      if (key?.ctrl && key.name === 'c') {
        cleanup();
        output.write('\n');
        reject(new Error('promptMasked: cancelled'));
        return;
      }
      if (key?.name === 'return' || key?.name === 'enter') {
        cleanup();
        output.write('\n');
        resolve(value);
        return;
      }
      if (key?.name === 'backspace') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          output.write('\b \b');
        }
        return;
      }
      if (str && !key?.ctrl) {
        value += str;
        output.write('*');
      }
    }

    input.on('keypress', onKeypress);
    (input as NodeJS.ReadStream).resume?.();
  });
}
