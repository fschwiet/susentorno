// Fixture for mcpServerProcess.test.ts: exits right away without binding anything, to
// exercise the "exited before ready" startup-failure path.
console.log('exiting immediately');
process.exit(7);
