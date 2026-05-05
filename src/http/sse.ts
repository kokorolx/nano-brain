import type * as http from 'http';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { log } from '../logger.js';

export const sseSessions = new Map<string, { transport: SSEServerTransport; server: McpServer }>();

export async function handleSseConnect(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  clientServer: McpServer
): Promise<void> {
  const transport = new SSEServerTransport('/messages', res);

  transport.onclose = () => {
    sseSessions.delete(transport.sessionId);
    log('server', `SSE client disconnected sessionId=${transport.sessionId}`);
  };

  try {
    sseSessions.set(transport.sessionId, { transport, server: clientServer });
    log('server', `SSE client connected sessionId=${transport.sessionId}`);
    await clientServer.connect(transport);
  } catch (err) {
    sseSessions.delete(transport.sessionId);
    log('server', `SSE client connect failed sessionId=${transport.sessionId}: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

export async function handleSseMessage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): Promise<void> {
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing sessionId parameter' }));
    return;
  }

  const session = sseSessions.get(sessionId);
  if (!session) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session not found' }));
    return;
  }

  await session.transport.handlePostMessage(req, res);
}
