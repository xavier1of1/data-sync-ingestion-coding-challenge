import type { Pool } from "pg";

import { ApiClient } from "./api/client";
import { CursorFetchStrategy } from "./api/cursor-fetch-strategy";
import { runDiscovery } from "./api/discovery";
import { bootstrapSchema } from "./bootstrap-schema";
import { loadConfig } from "./config";
import { connectWithRetry, createPool, closePool } from "./db";
import { exportEventIds } from "./export/export-event-ids";
import { Coordinator } from "./ingestion/coordinator";
import { Worker } from "./ingestion/worker";
import { createLogger } from "./logger";
import { EventsRepo } from "./repos/events-repo";
import { JobsRepo } from "./repos/jobs-repo";
import { RunsRepo } from "./repos/runs-repo";
import { submitResults } from "./submission/submit-results";

const config = loadConfig();
const logger = createLogger(config);

let pool: Pool | undefined;
let keepAliveTimer: NodeJS.Timeout | undefined;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, "shutting down ingestion service");

  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = undefined;
  }

  if (pool) {
    await closePool(pool, logger);
    pool = undefined;
  }

  process.exit(0);
}

async function main(): Promise<void> {
  logger.info("starting assignment-ingestion service");

  pool = createPool(config, logger);
  await connectWithRetry(pool, config, logger);

  const schemaSummary = await bootstrapSchema(pool, logger);

  logger.info(
    {
      tables: schemaSummary.tables,
      view: schemaSummary.viewName,
    },
    "schema bootstrap complete",
  );

  const apiClient = new ApiClient(config, logger);
  const discovery = await runDiscovery(apiClient, logger);

  logger.info(
    {
      selectedEndpoint: discovery.selectedEndpoint,
      authenticated: discovery.authenticated,
      paginationDetected: discovery.paginationDetected,
      cursorFields: discovery.cursorFields,
      alternateEndpoints: discovery.alternateEndpoints,
    },
    "discovery complete",
  );

  const eventsRepo = new EventsRepo();
  const jobsRepo = new JobsRepo();
  const runsRepo = new RunsRepo();

  const fetchStrategy = new CursorFetchStrategy(apiClient, config, logger, "/events");
  const worker = new Worker(pool, config, logger, fetchStrategy, eventsRepo, jobsRepo, runsRepo);
  const coordinator = new Coordinator(pool, config, logger, runsRepo, jobsRepo, worker);

  await coordinator.run(discovery);

  const exportResult = await exportEventIds(pool, config, logger);
  await submitResults(config, exportResult.filePath, logger);

  logger.info("ingestion complete");

  keepAliveTimer = setInterval(() => {
    logger.debug("ingestion complete and container kept alive for inspection");
  }, 60000);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandled promise rejection");
});

process.on("uncaughtException", (error) => {
  logger.error({ err: error }, "uncaught exception");
});

void main().catch(async (error: unknown) => {
  logger.error({ err: error }, "ingestion service failed");

  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = undefined;
  }

  if (pool) {
    await closePool(pool, logger);
  }

  process.exit(1);
});
