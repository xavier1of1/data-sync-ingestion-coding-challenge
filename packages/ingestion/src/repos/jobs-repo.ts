import type { Pool, PoolClient } from "pg";

import type { IngestionJobRecord } from "../types";

export class JobsRepo {
  public async recoverExpiredLeases(pool: Pool, runId: number): Promise<number> {
    const result = await pool.query(
      `
      UPDATE ingestion_jobs
      SET status = 'pending',
          lease_expires_at = NULL,
          available_at = NOW(),
          last_error = COALESCE(last_error, 'lease expired; requeued')
      WHERE run_id = $1
        AND status = 'leased'
        AND lease_expires_at < NOW()
      `,
      [runId],
    );

    return result.rowCount ?? 0;
  }

  public async recoverFailedJobsForRun(pool: Pool, runId: number): Promise<number> {
    const result = await pool.query(
      `
      UPDATE ingestion_jobs
      SET status = 'pending',
          available_at = NOW(),
          lease_expires_at = NULL,
          attempt_count = 0
      WHERE run_id = $1
        AND status = 'failed'
      `,
      [runId],
    );

    return result.rowCount ?? 0;
  }

  public async ensureSingleStreamJob(pool: Pool, runId: number, pageLimit: number): Promise<void> {
    const existing = await pool.query(
      `
      SELECT id
      FROM ingestion_jobs
      WHERE run_id = $1
      LIMIT 1
      `,
      [runId],
    );

    if ((existing.rowCount ?? 0) > 0) {
      return;
    }

    await pool.query(
      `
      INSERT INTO ingestion_jobs (
        run_id,
        status,
        partition_key,
        cursor,
        next_cursor,
        page_limit,
        attempt_count,
        lease_expires_at,
        available_at,
        pages_processed,
        events_seen,
        events_inserted,
        last_http_status,
        last_error
      )
      VALUES ($1, 'pending', 'default', NULL, NULL, $2, 0, NULL, NOW(), 0, 0, 0, NULL, NULL)
      `,
      [runId, pageLimit],
    );
  }

  public async bumpPageLimitForRun(pool: Pool, runId: number, pageLimit: number): Promise<number> {
    const result = await pool.query(
      `
      UPDATE ingestion_jobs
      SET page_limit = $2
      WHERE run_id = $1
        AND status <> 'completed'
        AND page_limit < $2
      `,
      [runId, pageLimit],
    );

    return result.rowCount ?? 0;
  }

  public async leaseNextJob(
    pool: Pool,
    runId: number,
    leaseDurationSeconds: number,
  ): Promise<IngestionJobRecord | null> {
    const result = await pool.query(
      `
      WITH candidate AS (
        SELECT id
        FROM ingestion_jobs
        WHERE run_id = $1
          AND available_at <= NOW()
          AND (
            status = 'pending'
            OR (status = 'leased' AND lease_expires_at < NOW())
          )
        ORDER BY id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE ingestion_jobs AS job
      SET status = 'leased',
          lease_expires_at = NOW() + ($2 * INTERVAL '1 second')
      FROM candidate
      WHERE job.id = candidate.id
      RETURNING job.*
      `,
      [runId, leaseDurationSeconds],
    );

    if ((result.rowCount ?? 0) === 0) {
      return null;
    }

    return mapJob(result.rows[0]);
  }

  public async countIncomplete(pool: Pool, runId: number): Promise<number> {
    const result = await pool.query<{ count: string }>(
      `
      SELECT COUNT(*)::text AS count
      FROM ingestion_jobs
      WHERE run_id = $1
        AND status <> 'completed'
      `,
      [runId],
    );

    return Number(result.rows[0]?.count ?? 0);
  }

  public async recordPageSuccess(
    client: PoolClient,
    jobId: number,
    args: {
      nextCursor: string | null;
      hasMore: boolean;
      recordsSeen: number;
      recordsInserted: number;
      httpStatus: number;
    },
  ): Promise<void> {
    const nextStatus = args.hasMore ? "pending" : "completed";

    await client.query(
      `
      UPDATE ingestion_jobs
      SET status = $2,
          cursor = $3,
          next_cursor = $4,
          lease_expires_at = NULL,
          available_at = NOW(),
          pages_processed = pages_processed + 1,
          events_seen = events_seen + $5,
          events_inserted = events_inserted + $6,
          last_http_status = $7,
          last_error = NULL,
          attempt_count = 0
      WHERE id = $1
      `,
      [
        jobId,
        nextStatus,
        args.nextCursor,
        args.nextCursor,
        args.recordsSeen,
        args.recordsInserted,
        args.httpStatus,
      ],
    );
  }

  public async requeueAfterTransientError(
    pool: Pool,
    jobId: number,
    args: {
      retryDelayMs: number;
      errorMessage: string;
      httpStatus: number | null;
    },
  ): Promise<void> {
    await pool.query(
      `
      UPDATE ingestion_jobs
      SET status = 'pending',
          lease_expires_at = NULL,
          available_at = NOW() + ($2 * INTERVAL '1 millisecond'),
          attempt_count = attempt_count + 1,
          last_error = $3,
          last_http_status = $4
      WHERE id = $1
      `,
      [jobId, args.retryDelayMs, truncateError(args.errorMessage), args.httpStatus],
    );
  }

  public async resetCursorToRoot(
    pool: Pool,
    jobId: number,
    args: {
      retryDelayMs: number;
      errorMessage: string;
      httpStatus: number | null;
    },
  ): Promise<void> {
    await pool.query(
      `
      UPDATE ingestion_jobs
      SET status = 'pending',
          cursor = NULL,
          next_cursor = NULL,
          lease_expires_at = NULL,
          available_at = NOW() + ($2 * INTERVAL '1 millisecond'),
          attempt_count = attempt_count + 1,
          last_error = $3,
          last_http_status = $4
      WHERE id = $1
      `,
      [jobId, args.retryDelayMs, truncateError(args.errorMessage), args.httpStatus],
    );
  }

  public async failJob(pool: Pool, jobId: number, message: string, httpStatus: number | null): Promise<void> {
    await pool.query(
      `
      UPDATE ingestion_jobs
      SET status = 'failed',
          lease_expires_at = NULL,
          last_error = $2,
          last_http_status = $3
      WHERE id = $1
      `,
      [jobId, truncateError(message), httpStatus],
    );
  }
}

function mapJob(row: any): IngestionJobRecord {
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    status: row.status,
    partitionKey: row.partition_key,
    cursor: row.cursor,
    nextCursor: row.next_cursor,
    pageLimit: Number(row.page_limit),
    attemptCount: Number(row.attempt_count ?? 0),
    leaseExpiresAt: row.lease_expires_at,
    availableAt: row.available_at,
    pagesProcessed: Number(row.pages_processed ?? 0),
    eventsSeen: Number(row.events_seen ?? 0),
    eventsInserted: Number(row.events_inserted ?? 0),
    lastHttpStatus: row.last_http_status,
    lastError: row.last_error,
  };
}

function truncateError(message: string): string {
  return message.length <= 2000 ? message : `${message.slice(0, 1997)}...`;
}




