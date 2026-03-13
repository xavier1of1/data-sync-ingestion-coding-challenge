import dotenv from "dotenv";
import { z } from "zod";

import type { AppConfig } from "./types";

dotenv.config();

const nullableUrl = z.preprocess(
  (value) => {
    if (typeof value !== "string") {
      return value;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  },
  z.string().url().optional(),
);

const envSchema = z.object({
  APPLICATION_NAME: z.string().min(1).default("assignment-ingestion"),
  API_BASE_URL: z.string().url(),
  TARGET_API_KEY: z.string().min(1),
  API_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgresql://postgres:postgres@localhost:5434/ingestion"),
  DB_CONNECT_RETRY_ATTEMPTS: z.coerce.number().int().positive().default(20),
  DB_CONNECT_RETRY_DELAY_MS: z.coerce.number().int().positive().default(1000),
  DB_POOL_MAX: z.coerce.number().int().positive().default(5),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  DB_SYNCHRONOUS_COMMIT: z
    .enum(["on", "off", "local", "remote_write", "remote_apply"])
    .default("off"),
  DEFAULT_PAGE_LIMIT: z.coerce.number().int().positive().default(1000),
  LEASE_DURATION_SECONDS: z.coerce.number().int().positive().default(30),
  WORKER_POLL_DELAY_MS: z.coerce.number().int().positive().default(1000),
  MAX_TRANSIENT_RETRIES: z.coerce.number().int().positive().default(4),
  RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(250),
  RETRY_MAX_DELAY_MS: z.coerce.number().int().positive().default(5000),
  EXPORT_FILE_PATH: z.string().min(1).default("/app/output/event_ids.txt"),
  EXPORT_BATCH_SIZE: z.coerce.number().int().positive().default(5000),
  GITHUB_REPO_URL: nullableUrl,
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export function loadConfig(): AppConfig {
  const parsed = envSchema.parse(process.env);

  return {
    applicationName: parsed.APPLICATION_NAME,
    apiBaseUrl: parsed.API_BASE_URL,
    targetApiKey: parsed.TARGET_API_KEY,
    apiRequestTimeoutMs: parsed.API_REQUEST_TIMEOUT_MS,
    databaseUrl: parsed.DATABASE_URL,
    dbConnectRetryAttempts: parsed.DB_CONNECT_RETRY_ATTEMPTS,
    dbConnectRetryDelayMs: parsed.DB_CONNECT_RETRY_DELAY_MS,
    dbPoolMax: parsed.DB_POOL_MAX,
    dbStatementTimeoutMs: parsed.DB_STATEMENT_TIMEOUT_MS,
    dbSynchronousCommit: parsed.DB_SYNCHRONOUS_COMMIT,
    defaultPageLimit: parsed.DEFAULT_PAGE_LIMIT,
    leaseDurationSeconds: parsed.LEASE_DURATION_SECONDS,
    workerPollDelayMs: parsed.WORKER_POLL_DELAY_MS,
    maxTransientRetries: parsed.MAX_TRANSIENT_RETRIES,
    retryBaseDelayMs: parsed.RETRY_BASE_DELAY_MS,
    retryMaxDelayMs: parsed.RETRY_MAX_DELAY_MS,
    exportFilePath: parsed.EXPORT_FILE_PATH,
    exportBatchSize: parsed.EXPORT_BATCH_SIZE,
    githubRepoUrl: parsed.GITHUB_REPO_URL ?? null,
    logLevel: parsed.LOG_LEVEL,
    nodeEnv: parsed.NODE_ENV,
  };
}
