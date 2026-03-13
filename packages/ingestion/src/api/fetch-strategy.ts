import type { IngestionJobRecord } from "../types";

export interface FetchPageResult {
  records: unknown[];
  nextCursor: string | null;
  hasMore: boolean;
  httpStatus: number;
  headers: Record<string, string>;
}

export interface FetchStrategy {
  readonly name: string;
  fetchPage(job: IngestionJobRecord): Promise<FetchPageResult>;
}
