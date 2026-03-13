import type { Logger } from "pino";

import { ApiClient } from "./client";
import type { FetchPageResult, FetchStrategy } from "./fetch-strategy";
import type { AppConfig, IngestionJobRecord } from "../types";

export class CursorFetchStrategy implements FetchStrategy {
  public readonly name = "cursor";

  public constructor(
    private readonly apiClient: ApiClient,
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly endpoint: string,
  ) {}

  public async fetchPage(job: IngestionJobRecord): Promise<FetchPageResult> {
    const params: Record<string, unknown> = {
      limit: job.pageLimit,
    };

    if (job.cursor) {
      params.cursor = job.cursor;
    }

    const response = await this.apiClient.getWithRetry(this.endpoint, params, {
      maxAttempts: this.config.maxTransientRetries,
    });

    const records = extractRecords(response.data);
    const nextCursor = extractNextCursor(response.data);
    const hasMore = extractHasMore(response.data, nextCursor, records.length, job.pageLimit);

    this.logger.debug(
      {
        jobId: job.id,
        endpoint: this.endpoint,
        records: records.length,
        hasMore,
        nextCursor,
      },
      "cursor page fetched",
    );

    return {
      records,
      nextCursor,
      hasMore,
      httpStatus: response.status,
      headers: response.headers,
    };
  }
}

function extractRecords(data: unknown): unknown[] {
  if (Array.isArray(data)) {
    return data;
  }

  if (!isObject(data)) {
    return [];
  }

  const candidates = [data.data, data.events, data.results, data.items];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

function extractNextCursor(data: unknown): string | null {
  if (!isObject(data)) {
    return null;
  }

  const direct = coerceString(data.nextCursor) ?? coerceString(data.cursor);

  if (direct) {
    return direct;
  }

  if (isObject(data.pagination)) {
    return (
      coerceString(data.pagination.nextCursor) ??
      coerceString(data.pagination.cursor) ??
      coerceString(data.pagination.next)
    );
  }

  return null;
}

function extractHasMore(
  data: unknown,
  nextCursor: string | null,
  recordsCount: number,
  requestedLimit: number,
): boolean {
  if (isObject(data)) {
    const direct = coerceBoolean(data.hasMore);

    if (typeof direct === "boolean") {
      return direct;
    }

    if (isObject(data.pagination)) {
      const nested = coerceBoolean(data.pagination.hasMore);

      if (typeof nested === "boolean") {
        return nested;
      }
    }
  }

  if (nextCursor) {
    return true;
  }

  return recordsCount >= requestedLimit;
}

function coerceString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function coerceBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  return null;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
