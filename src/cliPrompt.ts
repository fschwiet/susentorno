import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';

export interface PromptStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/** The prompt functions a setup command's answer resolution asks its questions through. */
export interface SetupAnswerPrompts {
  text: (question: string, defaultValue?: string) => Promise<string>;
  masked: (question: string) => Promise<string>;
}

/**
 * A prompt that can no longer be answered: the input reached EOF before an
 * answer arrived, or the user cancelled it (Ctrl+C). A typed error so a command
 * can end cleanly instead of hanging on, or crashing over, a dead stdin.
 */
export class PromptEndedError extends Error {
  readonly reason: 'eof' | 'cancelled';
  readonly question: string;

  constructor(reason: 'eof' | 'cancelled', question: string, message?: string) {
    super(message ?? `Input ended before '${question}' was answered.`);
    this.name = 'PromptEndedError';
    this.reason = reason;
    this.question = question;
  }
}

/**
 * An input that already delivered its 'end' will never emit it, or close a
 * readline interface, again: a later prompt has to notice that up front.
 */
function hasEnded(input: NodeJS.ReadableStream): boolean {
  return (input as { readableEnded?: boolean }).readableEnded === true;
}

function defaultStreams(): PromptStreams {
  return { input: process.stdin, output: process.stdout };
}

export async function promptText(
  question: string,
  defaultValue?: string,
  streams: PromptStreams = defaultStreams(),
): Promise<string> {
  if (hasEnded(streams.input)) throw new PromptEndedError('eof', question);
  const rl = createInterface({ input: streams.input, output: streams.output });
  const suffix = defaultValue !== undefined ? ` [${defaultValue}]` : '';
  // Without this a closed input leaves rl.question() pending forever, and the
  // process exits silently (Node's "unsettled top-level await", code 13).
  const ended = new Promise<never>((_, reject) => {
    rl.once('close', () => reject(new PromptEndedError('eof', question)));
    rl.once('SIGINT', () => reject(new PromptEndedError('cancelled', question)));
  });
  ended.catch(() => {});
  let answer: string;
  try {
    answer = (await Promise.race([rl.question(`${question}${suffix}: `), ended])).trim();
  } finally {
    rl.close();
  }
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
    if (hasEnded(input)) {
      reject(new PromptEndedError('eof', question));
      return;
    }
    output.write(`${question}: `);
    let value = '';

    emitKeypressEvents(input as NodeJS.ReadStream);
    const ttyInput = input as NodeJS.ReadStream;
    const isTTY = ttyInput.isTTY === true;
    if (isTTY) ttyInput.setRawMode(true);

    const cleanup = () => {
      input.removeListener('keypress', onKeypress);
      input.removeListener('end', onEnd);
      if (isTTY) ttyInput.setRawMode(false);
      // Unconditional, not just when isTTY: emitKeypressEvents attaches an
      // internal `data` listener to `input` with no public removal API, which
      // keeps the stream in flowing mode — and therefore still reading from
      // the console — even after our own `keypress` listener is gone and raw mode
      // is off. pause() forces it out of flowing mode regardless of what else
      // is still attached, so a child process spawned right after this
      // (ssh with stdio: 'inherit') can read the console instead of racing us
      // for it. See ADR-0022.
      input.pause();
    };

    function onKeypress(str: string | undefined, key: Keypress) {
      if (key?.ctrl && key.name === 'c') {
        cleanup();
        output.write('\n');
        reject(new PromptEndedError('cancelled', question, 'promptMasked: cancelled'));
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

    // Piped input with no trailing newline still counts as an answer; an
    // empty EOF is an ended prompt, never a silently empty password.
    function onEnd() {
      cleanup();
      output.write('\n');
      if (value.length > 0) resolve(value);
      else reject(new PromptEndedError('eof', question));
    }

    input.on('keypress', onKeypress);
    input.on('end', onEnd);
    (input as NodeJS.ReadStream).resume?.();
  });
}
