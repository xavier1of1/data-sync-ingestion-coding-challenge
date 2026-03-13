import { mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

import type { Pool } from "pg";
import type { Logger } from "pino";

import { EventsRepo } from "../repos/events-repo";
import type { AppConfig } from "../types";

export async function exportEventIds(
  pool: Pool,
  config: AppConfig,
  logger: Logger,
): Promise<{ filePath: string; exportedCount: number }> {
  const repo = new EventsRepo();
  const outputPath = config.exportFilePath;
  const outputDirectory = path.dirname(outputPath);

  await mkdir(outputDirectory, { recursive: true });
  await writeFile(outputPath, "", { encoding: "utf8" });

  let lastId: string | null = null;
  let exportedCount = 0;

  while (true) {
    const ids = await repo.fetchEventIdsBatch(pool, lastId, config.exportBatchSize);

    if (ids.length === 0) {
      break;
    }

    await appendFile(outputPath, `${ids.join("\n")}\n`, { encoding: "utf8" });

    exportedCount += ids.length;
    lastId = ids[ids.length - 1] ?? lastId;
  }

  logger.info({ outputPath, exportedCount }, "event id export complete");

  return {
    filePath: outputPath,
    exportedCount,
  };
}
