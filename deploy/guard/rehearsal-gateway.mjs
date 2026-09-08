// An inert receiver stand-in for lifecycle tests. It has no credentials,
// bookkeeping tools, message transport or outbound network requests.
import http from 'node:http';
const server = http.createServer((request, response) => {
  response.writeHead(request.url === '/readyz' ? 200 : 404); response.end('rehearsal');
});
server.listen(18789, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
