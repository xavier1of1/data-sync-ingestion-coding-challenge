export type NodeEnv = "development" | "test" | "production";

export type LogLevel =
  | "fatal"
  | "error"
  | "warn"
  | "info"
  | "debug"
  | "trace"
  | "silent";

export type SynchronousCommitMode =
  | "on"
  | "off"
  | "local"
  | "remote_write"
  | "remote_apply";

export type RunStatus = "pending" | "running" | "completed" | "failed";

export type JobStatus = "pending" | "leased" | "completed" | "failed";

export interface AppConfig {
  applicationName: string;
  apiBaseUrl: string;
  targetApiKey: string;
  apiRequestTimeoutMs: number;
  databaseUrl: string;
  dbConnectRetryAttempts: number;
  dbConnectRetryDelayMs: number;
  dbPoolMax: number;
  dbStatementTimeoutMs: number;
  dbSynchronousCommit: SynchronousCommitMode;
  defaultPageLimit: number;
  leaseDurationSeconds: number;
  workerPollDelayMs: number;
  maxTransientRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  exportFilePath: string;
  exportBatchSize: number;
  githubRepoUrl: string | null;
  logLevel: LogLevel;
  nodeEnv: NodeEnv;
}

export interface BootstrapSummary {
  tables: readonly ["events", "ingestion_runs", "ingestion_jobs"];
  viewName: "ingested_events";
}

export interface HeaderSnapshot {
  endpoint: string;
  status: number;
  headers: Record<string, string>;
}

export interface PageLimitProbe {
  requestedLimit: number;
  status: number;
  returnedRecords: number;
}

export interface DiscoveryResult {
  authenticated: boolean;
  selectedEndpoint: string | null;
  alternateEndpoints: string[];
  paginationDetected: boolean;
  cursorFields: string[];
  pageLimitProbes: PageLimitProbe[];
  headerSnapshots: HeaderSnapshot[];
}

export interface IngestionRunRecord {
  id: number;
  status: RunStatus;
  mode: string;
  startedAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  eventsInserted: number;
  pagesProcessed: number;
  lastError: string | null;
}

export interface IngestionJobRecord {
  id: number;
  runId: number;
  status: JobStatus;
  partitionKey: string;
  cursor: string | null;
  nextCursor: string | null;
  pageLimit: number;
  attemptCount: number;
  leaseExpiresAt: Date | null;
  availableAt: Date;
  pagesProcessed: number;
  eventsSeen: number;
  eventsInserted: number;
  lastHttpStatus: number | null;
  lastError: string | null;
}

export interface NormalizedEvent {
  id: string;
  eventType: string | null;
  occurredAt: Date | null;
  rawPayload: Record<string, unknown>;
  ingestedAt: Date;
}
