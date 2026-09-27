// THROWAWAY PROTOTYPE checks. Run: node prototype.test.mjs
import assert from 'node:assert/strict';
import { invokePrototype } from './prototype.mjs';

const awkwardScript = [
  // Quotes, PowerShell metacharacters, newlines, BMP and supplementary Unicode.
  "[Console]::Out.Write('single '' quote; double \" quote; dollar $; backtick `; snowman ☃; 𠜎')",
  "[Console]::Error.Write('separate-error-☃')",
  'exit 23',
].join('\n');

let observedCommand;
const result = await invokePrototype({
  local: true,
  username: 'name-not-in-argv',
  password: "secret-'-$-☃-not-in-argv",
  script: awkwardScript,
  observeSpawn(command, args) {
    observedCommand = [command, ...args].join(' ');
  },
});

assert.equal(result.exitCode, 23);
assert.equal(result.timedOut, false);
assert.match(result.stdout, /single ' quote/);
assert.match(result.stdout, /snowman ☃; 𠜎/);
assert.equal(result.stderr, 'separate-error-☃');
assert.doesNotMatch(observedCommand, /secret|name-not-in-argv|snowman/);

const timeout = await invokePrototype({
  local: true,
  username: 'unused',
  password: 'unused',
  timeoutMs: 100,
  script: 'Start-Sleep -Seconds 30',
});
assert.equal(timeout.exitCode, 124);
assert.equal(timeout.timedOut, true);

console.log('prototype checks passed');
