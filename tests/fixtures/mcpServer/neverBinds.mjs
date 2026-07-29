// Fixture for mcpServerProcess.test.ts: stays alive but never binds any socket, to
// exercise the "never becomes ready within the timeout" startup-failure path.
console.log('never binds');
setInterval(() => {}, 1000);
