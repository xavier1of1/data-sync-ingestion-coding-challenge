import { setTimeout as delay } from "node:timers/promises";

import { Pool, type PoolClient } from "pg";
import type { Logger } from "pino";

import type { AppConfig } from "./types";

export function createPool(config: AppConfig, logger: Logger): Pool {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  pool.on("error", (error) => {
    logger.error({ err: error }, "postgres pool emitted an unexpected error");
  });

  pool.on("connect", (client) => {
    void applySessionSettings(client, config).catch((error: unknown) => {
      logger.error({ err: error }, "failed to apply postgres session settings");
    });
  });

  return pool;
}

export async function connectWithRetry(
  pool: Pool,
  config: AppConfig,
  logger: Logger,
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.dbConnectRetryAttempts; attempt += 1) {
    try {
      const client = await pool.connect();

      try {
        await applySessionSettings(client, config);
        await client.query("SELECT 1");
      } finally {
        client.release();
      }

      logger.info({ attempt }, "postgres connection established");
      return;
    } catch (error) {
      lastError = error;

      logger.warn(
        {
          attempt,
          maxAttempts: config.dbConnectRetryAttempts,
          err: error,
        },
        "postgres connection attempt failed",
      );

      if (attempt < config.dbConnectRetryAttempts) {
        await delay(config.dbConnectRetryDelayMs);
      }
    }
  }

  throw lastError ?? new Error("postgres connection failed without an error");
}

export async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(pool: Pool, logger: Logger): Promise<void> {
  await pool.end();
  logger.info("postgres pool closed");
}

async function applySessionSettings(client: PoolClient, config: AppConfig): Promise<void> {
  await client.query("SELECT set_config('application_name', $1, false)", [config.applicationName]);
  await client.query("SELECT set_config('statement_timeout', $1, false)", [
    String(config.dbStatementTimeoutMs),
  ]);
  await client.query("SELECT set_config('synchronous_commit', $1, false)", [
    config.dbSynchronousCommit,
  ]);
}
