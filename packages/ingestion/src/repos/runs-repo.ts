import type { Pool, PoolClient } from "pg";

import type { DiscoveryResult, IngestionRunRecord, RunStatus } from "../types";

export class RunsRepo {
  public async findLatestIncomplete(pool: Pool): Promise<IngestionRunRecord | null> {
    const result = await pool.query(
      `
      SELECT *
      FROM ingestion_runs
      WHERE status IN ('pending', 'running')
      ORDER BY id DESC
      LIMIT 1
      `,
    );

    if (result.rowCount === 0) {
      return null;
    }

    return mapRun(result.rows[0]);
  }

  public async findLatestFailed(pool: Pool): Promise<IngestionRunRecord | null> {
    const result = await pool.query(
      `
      SELECT *
      FROM ingestion_runs
      WHERE status = 'failed'
      ORDER BY id DESC
      LIMIT 1
      `,
    );

    if (result.rowCount === 0) {
      return null;
    }

    return mapRun(result.rows[0]);
  }

  public async createRun(
    pool: Pool,
    mode: string,
    discoverySnapshot: DiscoveryResult,
  ): Promise<IngestionRunRecord> {
    const result = await pool.query(
      `
      INSERT INTO ingestion_runs (status, mode, discovery_snapshot)
      VALUES ('running', $1, $2::jsonb)
      RETURNING *
      `,
      [mode, JSON.stringify(discoverySnapshot)],
    );

    return mapRun(result.rows[0]);
  }

  public async setStatus(pool: Pool, runId: number, status: RunStatus, lastError?: string): Promise<void> {
    await pool.query(
      `
      UPDATE ingestion_runs
      SET status = $2,
          updated_at = NOW(),
          last_error = $3
      WHERE id = $1
      `,
      [runId, status, lastError ?? null],
    );
  }

  public async markCompleted(pool: Pool, runId: number): Promise<void> {
    await pool.query(
      `
      UPDATE ingestion_runs
      SET status = 'completed',
          updated_at = NOW(),
          completed_at = NOW(),
          last_error = NULL
      WHERE id = $1
      `,
      [runId],
    );
  }

  public async markFailed(pool: Pool, runId: number, message: string): Promise<void> {
    await pool.query(
      `
      UPDATE ingestion_runs
      SET status = 'failed',
          updated_at = NOW(),
          last_error = $2
      WHERE id = $1
      `,
      [runId, message],
    );
  }

  public async incrementProgress(
    client: PoolClient,
    runId: number,
    pagesProcessed: number,
    eventsInserted: number,
  ): Promise<void> {
    await client.query(
      `
      UPDATE ingestion_runs
      SET pages_processed = pages_processed + $2,
          events_inserted = events_inserted + $3,
          updated_at = NOW()
      WHERE id = $1
      `,
      [runId, pagesProcessed, eventsInserted],
    );
  }
}

function mapRun(row: any): IngestionRunRecord {
  return {
    id: Number(row.id),
    status: row.status,
    mode: row.mode,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    eventsInserted: Number(row.events_inserted ?? 0),
    pagesProcessed: Number(row.pages_processed ?? 0),
    lastError: row.last_error,
  };
}


