import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { EventStore, StreamId, EventId } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export class SqliteEventStore implements EventStore {
  private db: Database.Database;
  private ttlSeconds: number;

  constructor(db: Database.Database, ttlSeconds: number = 300) {
    this.db = db;
    this.ttlSeconds = ttlSeconds;
    this.ensureTable();
    try { this.cleanupStale(); } catch {}
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_events (
        event_id TEXT PRIMARY KEY,
        stream_id TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_events_stream ON mcp_events(stream_id, event_id);
    `);
  }

  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const eventId = randomUUID();
    const createdAt = Math.floor(Date.now() / 1000);
    this.db.prepare(
      'INSERT INTO mcp_events (event_id, stream_id, message, created_at) VALUES (?, ?, ?, ?)'
    ).run(eventId, streamId, JSON.stringify(message), createdAt);
    return eventId;
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> }
  ): Promise<StreamId> {
    const streamRow = this.db.prepare(
      'SELECT stream_id FROM mcp_events WHERE event_id = ?'
    ).get(lastEventId) as { stream_id: string } | undefined;

    if (!streamRow) {
      throw new Error(`Event not found: ${lastEventId}`);
    }

    const streamId = streamRow.stream_id;

    const rows = this.db.prepare(`
      SELECT event_id, message FROM mcp_events 
      WHERE stream_id = ? AND rowid > (SELECT rowid FROM mcp_events WHERE event_id = ?) 
      ORDER BY rowid ASC
    `).all(streamId, lastEventId) as Array<{ event_id: string; message: string }>;

    for (const row of rows) {
      await send(row.event_id, JSON.parse(row.message) as JSONRPCMessage);
    }

    return streamId;
  }

  cleanup(): void {
    try {
      const cutoff = Math.floor(Date.now() / 1000) - this.ttlSeconds;
      this.db.prepare('DELETE FROM mcp_events WHERE created_at < ?').run(cutoff);
    } catch {}
  }

  private cleanupStale(): void {
    this.cleanup();
  }
}
