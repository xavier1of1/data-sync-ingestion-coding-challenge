import type { Pool, PoolClient } from "pg";

import type { NormalizedEvent } from "../types";

const INSERT_CHUNK_SIZE = 5000;

export class EventsRepo {
  public async insertBatch(client: PoolClient, events: NormalizedEvent[]): Promise<number> {
    if (events.length === 0) {
      return 0;
    }

    let insertedTotal = 0;

    for (let start = 0; start < events.length; start += INSERT_CHUNK_SIZE) {
      const chunk = events.slice(start, start + INSERT_CHUNK_SIZE);
      insertedTotal += await insertChunk(client, chunk);
    }

    return insertedTotal;
  }

  public async fetchEventIdsBatch(
    pool: Pool,
    lastId: string | null,
    batchSize: number,
  ): Promise<string[]> {
    const result = await pool.query<{ id: string }>(
      `
      SELECT id
      FROM events
      WHERE ($1::text IS NULL OR id > $1)
      ORDER BY id ASC
      LIMIT $2
      `,
      [lastId, batchSize],
    );

    return result.rows.map((row) => row.id);
  }
}

async function insertChunk(client: PoolClient, events: NormalizedEvent[]): Promise<number> {
  const values: unknown[] = [];
  const tuples: string[] = [];

  events.forEach((event, index) => {
    const offset = index * 5;

    values.push(
      event.id,
      event.eventType,
      event.occurredAt,
      JSON.stringify(event.rawPayload),
      event.ingestedAt,
    );

    tuples.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}::jsonb, $${offset + 5})`,
    );
  });

  const result = await client.query(
    `
    INSERT INTO events (id, event_type, occurred_at, raw_payload, ingested_at)
    VALUES ${tuples.join(",")}
    ON CONFLICT (id) DO NOTHING
    RETURNING id
    `,
    values,
  );

  return result.rowCount ?? 0;
}
