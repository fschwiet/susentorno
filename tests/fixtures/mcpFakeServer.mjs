import { createServer } from 'node:http';

const [, , ip, port] = process.argv;

createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`mcp ok:${req.url}`);
}).listen(Number(port), ip);
