import http from 'node:http';
// The only listener is IPv4 loopback. Derive allowed authorities from the
// actual port so ephemeral verification uses the same request checks.
export function statusHttpServer({ assets, snapshot }) {
  const server = http.createServer((request, response) => {
    const port = server.address()?.port, hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" };
    if (!hosts.includes(request.headers.host) || (request.headers.origin && !hosts.some(host => request.headers.origin === `http://${host}`))) {
      response.writeHead(403, headers); response.end(); return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, headers); response.end(); return; }
    const asset = request.url === '/status.json' ? { type: 'application/json; charset=utf-8', body: JSON.stringify(snapshot()) } : assets.get(request.url);
    if (!asset) { response.writeHead(404, headers); response.end(); return; }
    response.writeHead(200, { ...headers, 'Content-Type': asset.type });
    response.end(request.method === 'HEAD' ? undefined : asset.body);
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  return server;
}
