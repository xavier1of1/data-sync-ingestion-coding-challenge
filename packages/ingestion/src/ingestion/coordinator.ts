import { setTimeout as delay } from "node:timers/promises";

import type { Pool } from "pg";
import type { Logger } from "pino";

import { JobsRepo } from "../repos/jobs-repo";
import { RunsRepo } from "../repos/runs-repo";
import type { AppConfig, DiscoveryResult, IngestionRunRecord } from "../types";
import { Worker } from "./worker";

export class Coordinator {
  public constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly runsRepo: RunsRepo,
    private readonly jobsRepo: JobsRepo,
    private readonly worker: Worker,
  ) {}

  public async run(discovery: DiscoveryResult): Promise<IngestionRunRecord> {
    const pageLimit = choosePageLimit(discovery, this.config.defaultPageLimit);

    const run = await this.getOrCreateRun(discovery);

    await this.jobsRepo.recoverExpiredLeases(this.pool, run.id);
    const recoveredFailedJobs = await this.jobsRepo.recoverFailedJobsForRun(this.pool, run.id);
    await this.jobsRepo.ensureSingleStreamJob(this.pool, run.id, pageLimit);

    if (recoveredFailedJobs > 0) {
      this.logger.info(
        {
          runId: run.id,
          recoveredFailedJobs,
        },
        "recovered failed jobs for resumed run",
      );
    }

    const updatedJobLimits = await this.jobsRepo.bumpPageLimitForRun(this.pool, run.id, pageLimit);

    if (updatedJobLimits > 0) {
      this.logger.info(
        {
          runId: run.id,
          updatedJobLimits,
          pageLimit,
        },
        "updated existing job page limits to discovered value",
      );
    }

    this.logger.info(
      {
        runId: run.id,
        mode: run.mode,
        pageLimit,
      },
      "coordinator started",
    );

    try {
      while (true) {
        const leasedJob = await this.jobsRepo.leaseNextJob(
          this.pool,
          run.id,
          this.config.leaseDurationSeconds,
        );

        if (!leasedJob) {
          const remaining = await this.jobsRepo.countIncomplete(this.pool, run.id);

          if (remaining === 0) {
            break;
          }

          await delay(this.config.workerPollDelayMs);
          continue;
        }

        await this.worker.processLeasedJob(leasedJob);
      }

      await this.runsRepo.markCompleted(this.pool, run.id);

      this.logger.info({ runId: run.id }, "coordinator completed run");

      const completed = await this.runsRepo.findLatestIncomplete(this.pool);

      if (completed) {
        return completed;
      }

      return {
        ...run,
        status: "completed",
        completedAt: new Date(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown coordinator error";
      await this.runsRepo.markFailed(this.pool, run.id, message);
      throw error;
    }
  }

  private async getOrCreateRun(discovery: DiscoveryResult): Promise<IngestionRunRecord> {
    const existing = await this.runsRepo.findLatestIncomplete(this.pool);

    if (existing) {
      await this.runsRepo.setStatus(this.pool, existing.id, "running");
      return {
        ...existing,
        status: "running",
      };
    }

    const failed = await this.runsRepo.findLatestFailed(this.pool);

    if (failed) {
      await this.runsRepo.setStatus(this.pool, failed.id, "running");
      return {
        ...failed,
        status: "running",
      };
    }

    return this.runsRepo.createRun(this.pool, "single-stream", discovery);
  }
}

function choosePageLimit(discovery: DiscoveryResult, fallback: number): number {
  const successful = discovery.pageLimitProbes
    .filter((probe) => probe.status >= 200 && probe.status < 300 && probe.returnedRecords > 0)
    .map((probe) => probe.returnedRecords);

  if (successful.length === 0) {
    return fallback;
  }

  return Math.max(...successful);
}



