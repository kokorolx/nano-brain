import * as http from 'http';
import { log } from '../logger.js';

export function createHttpServer(
  port: number,
  host: string,
  handler: http.RequestListener
): http.Server {
  const server = http.createServer(handler);

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log('server', `nano-brain already running on port ${port}`, 'error');
      process.exit(0);
    }
    throw err;
  });

  server.listen(port, host, () => {
    log('server', `MCP server listening on http://${host}:${port}`);
    log('server', `SSE endpoint: GET /sse, POST /messages?sessionId=<id>`);
    log('server', `Streamable HTTP endpoint: /mcp`);
  });

  return server;
}
