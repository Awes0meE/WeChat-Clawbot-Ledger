// A local liveness stand-in for a Tunnel child. Never forwards ledger requests,
// connects to Cloudflare, reads credentials or publishes a host port.
import http from 'node:http';
http.createServer((_request, response) => { response.writeHead(200); response.end('CLAWBOT_GUARDED_TEST_PUBLISHER'); })
  .listen(18991, '127.0.0.1');
