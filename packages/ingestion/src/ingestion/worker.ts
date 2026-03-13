import type { Pool } from "pg";
import type { Logger } from "pino";

import { ApiError } from "../api/client";
import type { FetchStrategy } from "../api/fetch-strategy";
import { withTransaction } from "../db";
import { normalizeEvent } from "../normalizer";
import { EventsRepo } from "../repos/events-repo";
import { JobsRepo } from "../repos/jobs-repo";
import { RunsRepo } from "../repos/runs-repo";
import type { AppConfig, IngestionJobRecord } from "../types";

export class Worker {
  public constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly strategy: FetchStrategy,
    private readonly eventsRepo: EventsRepo,
    private readonly jobsRepo: JobsRepo,
    private readonly runsRepo: RunsRepo,
  ) {}

  public async processLeasedJob(job: IngestionJobRecord): Promise<void> {
    try {
      const page = await this.strategy.fetchPage(job);

      const normalizedEvents = page.records
        .map((record) => normalizeEvent(record))
        .filter((event): event is NonNullable<typeof event> => event !== null);

      const insertedCount = await withTransaction(this.pool, async (client) => {
        const inserted = await this.eventsRepo.insertBatch(client, normalizedEvents);

        await this.jobsRepo.recordPageSuccess(client, job.id, {
          nextCursor: page.hasMore ? page.nextCursor : null,
          hasMore: page.hasMore,
          recordsSeen: page.records.length,
          recordsInserted: inserted,
          httpStatus: page.httpStatus,
        });

        await this.runsRepo.incrementProgress(client, job.runId, 1, inserted);

        return inserted;
      });

      const droppedDuringNormalization = page.records.length - normalizedEvents.length;

      this.logger.info(
        {
          jobId: job.id,
          strategy: this.strategy.name,
          fetchedRecords: page.records.length,
          normalizedRecords: normalizedEvents.length,
          insertedRecords: insertedCount,
          droppedRecords: droppedDuringNormalization,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
        },
        "processed ingestion page",
      );
    } catch (error) {
      await this.handleJobError(job, error);
    }
  }

  private async handleJobError(job: IngestionJobRecord, error: unknown): Promise<void> {
    if (error instanceof ApiError && error.staleCursor) {
      const retryDelayMs = Math.min(this.config.retryBaseDelayMs * 2, this.config.retryMaxDelayMs);

      await this.jobsRepo.resetCursorToRoot(this.pool, job.id, {
        retryDelayMs,
        errorMessage: error.message,
        httpStatus: error.status,
      });

      this.logger.warn(
        {
          jobId: job.id,
          status: error.status,
          retryDelayMs,
        },
        "stale cursor detected; job reset to root cursor",
      );

      return;
    }

    if (error instanceof ApiError && error.retriable) {
      const nextAttempt = job.attemptCount + 1;

      if (nextAttempt <= this.config.maxTransientRetries) {
        const retryDelayMs = computeRetryDelay(
          nextAttempt,
          this.config.retryBaseDelayMs,
          this.config.retryMaxDelayMs,
          error.retryAfterMs,
        );

        await this.jobsRepo.requeueAfterTransientError(this.pool, job.id, {
          retryDelayMs,
          errorMessage: error.message,
          httpStatus: error.status,
        });

        this.logger.warn(
          {
            jobId: job.id,
            attempt: nextAttempt,
            maxAttempts: this.config.maxTransientRetries,
            retryDelayMs,
            status: error.status,
          },
          "transient API error; job requeued",
        );

        return;
      }

      await this.jobsRepo.failJob(this.pool, job.id, error.message, error.status);
      throw new Error(`job ${job.id} exceeded transient retry budget: ${error.message}`);
    }

    const unexpectedMessage = error instanceof Error ? error.message : "unknown worker error";
    await this.jobsRepo.failJob(this.pool, job.id, unexpectedMessage, null);
    throw error instanceof Error ? error : new Error(unexpectedMessage);
  }
}

function computeRetryDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  retryAfterMs: number | null,
): number {
  if (retryAfterMs && retryAfterMs > 0) {
    return retryAfterMs;
  }

  const jitter = Math.floor(Math.random() * baseDelayMs);
  return Math.min(baseDelayMs * 2 ** (attempt - 1) + jitter, maxDelayMs);
}
