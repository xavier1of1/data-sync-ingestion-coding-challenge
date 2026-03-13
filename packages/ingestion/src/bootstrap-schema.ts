import type { Pool } from "pg";
import type { Logger } from "pino";

import { withTransaction } from "./db";
import type { BootstrapSummary } from "./types";

const BOOTSTRAPPED_TABLES = ["events", "ingestion_runs", "ingestion_jobs"] as const;

export async function bootstrapSchema(
  pool: Pool,
  logger: Logger,
): Promise<BootstrapSummary> {
  await withTransaction(pool, async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        event_type TEXT,
        occurred_at TIMESTAMPTZ,
        raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      ALTER TABLE events
        ADD COLUMN IF NOT EXISTS id TEXT,
        ADD COLUMN IF NOT EXISTS event_type TEXT,
        ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS raw_payload JSONB,
        ADD COLUMN IF NOT EXISTS ingested_at TIMESTAMPTZ
    `);

    await client.query(`
      UPDATE events
      SET raw_payload = '{}'::jsonb
      WHERE raw_payload IS NULL
    `);

    await client.query(`
      UPDATE events
      SET ingested_at = NOW()
      WHERE ingested_at IS NULL
    `);

    await client.query(`
      ALTER TABLE events
        ALTER COLUMN raw_payload SET DEFAULT '{}'::jsonb,
        ALTER COLUMN ingested_at SET DEFAULT NOW()
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'events_pkey'
            AND conrelid = 'events'::regclass
        ) THEN
          ALTER TABLE events
            ADD CONSTRAINT events_pkey PRIMARY KEY (id);
        END IF;
      END
      $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ingestion_runs (
        id BIGSERIAL PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'running',
        mode TEXT NOT NULL DEFAULT 'single-stream',
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        discovery_snapshot JSONB,
        events_inserted BIGINT NOT NULL DEFAULT 0,
        pages_processed BIGINT NOT NULL DEFAULT 0,
        last_error TEXT
      )
    `);

    await client.query(`
      ALTER TABLE ingestion_runs
        ADD COLUMN IF NOT EXISTS status TEXT,
        ADD COLUMN IF NOT EXISTS mode TEXT,
        ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS discovery_snapshot JSONB,
        ADD COLUMN IF NOT EXISTS events_inserted BIGINT,
        ADD COLUMN IF NOT EXISTS pages_processed BIGINT,
        ADD COLUMN IF NOT EXISTS last_error TEXT
    `);

    await client.query(`
      UPDATE ingestion_runs
      SET status = COALESCE(status, 'running'),
          mode = COALESCE(mode, 'single-stream'),
          started_at = COALESCE(started_at, NOW()),
          updated_at = COALESCE(updated_at, NOW()),
          events_inserted = COALESCE(events_inserted, 0),
          pages_processed = COALESCE(pages_processed, 0)
    `);

    await client.query(`
      ALTER TABLE ingestion_runs
        ALTER COLUMN status SET DEFAULT 'running',
        ALTER COLUMN mode SET DEFAULT 'single-stream',
        ALTER COLUMN started_at SET DEFAULT NOW(),
        ALTER COLUMN updated_at SET DEFAULT NOW(),
        ALTER COLUMN events_inserted SET DEFAULT 0,
        ALTER COLUMN pages_processed SET DEFAULT 0
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'ingestion_runs_pkey'
            AND conrelid = 'ingestion_runs'::regclass
        ) THEN
          ALTER TABLE ingestion_runs
            ADD CONSTRAINT ingestion_runs_pkey PRIMARY KEY (id);
        END IF;
      END
      $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ingestion_jobs (
        id BIGSERIAL PRIMARY KEY,
        run_id BIGINT NOT NULL REFERENCES ingestion_runs(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        partition_key TEXT NOT NULL DEFAULT 'default',
        cursor TEXT,
        next_cursor TEXT,
        page_limit INTEGER NOT NULL DEFAULT 100,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        lease_expires_at TIMESTAMPTZ,
        available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        pages_processed BIGINT NOT NULL DEFAULT 0,
        events_seen BIGINT NOT NULL DEFAULT 0,
        events_inserted BIGINT NOT NULL DEFAULT 0,
        last_http_status INTEGER,
        last_error TEXT
      )
    `);

    await client.query(`
      ALTER TABLE ingestion_jobs
        ADD COLUMN IF NOT EXISTS run_id BIGINT,
        ADD COLUMN IF NOT EXISTS status TEXT,
        ADD COLUMN IF NOT EXISTS partition_key TEXT,
        ADD COLUMN IF NOT EXISTS cursor TEXT,
        ADD COLUMN IF NOT EXISTS next_cursor TEXT,
        ADD COLUMN IF NOT EXISTS page_limit INTEGER,
        ADD COLUMN IF NOT EXISTS attempt_count INTEGER,
        ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS pages_processed BIGINT,
        ADD COLUMN IF NOT EXISTS events_seen BIGINT,
        ADD COLUMN IF NOT EXISTS events_inserted BIGINT,
        ADD COLUMN IF NOT EXISTS last_http_status INTEGER,
        ADD COLUMN IF NOT EXISTS last_error TEXT
    `);

    await client.query(`
      UPDATE ingestion_jobs
      SET status = COALESCE(status, 'pending'),
          partition_key = COALESCE(partition_key, 'default'),
          page_limit = COALESCE(page_limit, 100),
          attempt_count = COALESCE(attempt_count, 0),
          available_at = COALESCE(available_at, NOW()),
          pages_processed = COALESCE(pages_processed, 0),
          events_seen = COALESCE(events_seen, 0),
          events_inserted = COALESCE(events_inserted, 0)
    `);

    await client.query(`
      ALTER TABLE ingestion_jobs
        ALTER COLUMN status SET DEFAULT 'pending',
        ALTER COLUMN partition_key SET DEFAULT 'default',
        ALTER COLUMN page_limit SET DEFAULT 100,
        ALTER COLUMN attempt_count SET DEFAULT 0,
        ALTER COLUMN available_at SET DEFAULT NOW(),
        ALTER COLUMN pages_processed SET DEFAULT 0,
        ALTER COLUMN events_seen SET DEFAULT 0,
        ALTER COLUMN events_inserted SET DEFAULT 0
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'ingestion_jobs_pkey'
            AND conrelid = 'ingestion_jobs'::regclass
        ) THEN
          ALTER TABLE ingestion_jobs
            ADD CONSTRAINT ingestion_jobs_pkey PRIMARY KEY (id);
        END IF;
      END
      $$;
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'ingestion_jobs_run_id_fkey'
            AND conrelid = 'ingestion_jobs'::regclass
        ) THEN
          ALTER TABLE ingestion_jobs
            ADD CONSTRAINT ingestion_jobs_run_id_fkey
            FOREIGN KEY (run_id)
            REFERENCES ingestion_runs(id)
            ON DELETE CASCADE;
        END IF;
      END
      $$;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS ingestion_jobs_status_available_idx
        ON ingestion_jobs (status, available_at)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS ingestion_jobs_run_status_idx
        ON ingestion_jobs (run_id, status)
    `);

    await client.query(`
      CREATE OR REPLACE VIEW ingested_events AS
      SELECT *
      FROM events
    `);
  });

  logger.info(
    {
      tables: BOOTSTRAPPED_TABLES,
      view: "ingested_events",
    },
    "ensured bootstrap schema",
  );

  return {
    tables: BOOTSTRAPPED_TABLES,
    viewName: "ingested_events",
  };
}
