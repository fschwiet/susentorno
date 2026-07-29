// Fixture for mcpServerProcess.test.ts: binds a loopback TCP listener on the given
// ip/port, prints a line once listening (for the stdout-drain assertion), and exits
// cleanly on SIGTERM/SIGINT.
import net from 'node:net';

const [, , ip, portArg] = process.argv;
const port = Number(portArg);

const server = net.createServer((socket) => socket.end());
server.listen(port, ip, () => {
  console.log(`listening on ${ip}:${port}`);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
