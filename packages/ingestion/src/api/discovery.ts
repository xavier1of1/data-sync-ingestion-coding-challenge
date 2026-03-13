import type { Logger } from "pino";

import type { DiscoveryResult, HeaderSnapshot, PageLimitProbe } from "../types";
import type { ApiClient } from "./client";

const ENDPOINT_CANDIDATES = [
  "/events",
  "/analytics/events",
  "/dashboard/events",
  "/internal/events",
  "/event-stream/events",
];

const LIMIT_PROBES = [100, 250, 500, 1000, 2000];

export async function runDiscovery(
  client: ApiClient,
  logger: Logger,
): Promise<DiscoveryResult> {
  logger.info(
    {
      endpointCandidates: ENDPOINT_CANDIDATES,
    },
    "starting API discovery (live behavior overrides docs/api.md hints)",
  );

  const headerSnapshots: HeaderSnapshot[] = [];
  const successfulEndpoints: string[] = [];
  let selectedEndpoint: string | null = null;
  let selectedResponseData: unknown;

  for (const endpoint of ENDPOINT_CANDIDATES) {
    const response = await client.probe(endpoint, { limit: 1 });

    headerSnapshots.push({
      endpoint,
      status: response.status,
      headers: response.headers,
    });

    logger.info(
      {
        endpoint,
        status: response.status,
        headers: response.headers,
      },
      "discovery endpoint probe",
    );

    if (response.status >= 200 && response.status < 300) {
      successfulEndpoints.push(endpoint);

      if (!selectedEndpoint) {
        selectedEndpoint = endpoint;
        selectedResponseData = response.data;
      }
    }
  }

  const authenticated =
    successfulEndpoints.length > 0 ||
    headerSnapshots.some((snapshot) => snapshot.status !== 401 && snapshot.status !== 403);

  if (!selectedEndpoint) {
    logger.warn(
      {
        authenticated,
        statuses: headerSnapshots.map((snapshot) => ({
          endpoint: snapshot.endpoint,
          status: snapshot.status,
        })),
      },
      "discovery could not find a successful endpoint",
    );

    return {
      authenticated,
      selectedEndpoint: null,
      alternateEndpoints: [],
      paginationDetected: false,
      cursorFields: [],
      pageLimitProbes: [],
      headerSnapshots,
    };
  }

  const records = extractRecords(selectedResponseData);
  const cursorFields = detectCursorFields(selectedResponseData);
  const paginationDetected = detectPagination(selectedResponseData);

  const pageLimitProbes = await probePageLimits(client, logger, selectedEndpoint, headerSnapshots);

  const discoveryResult: DiscoveryResult = {
    authenticated,
    selectedEndpoint,
    alternateEndpoints: successfulEndpoints.filter((endpoint) => endpoint !== selectedEndpoint),
    paginationDetected,
    cursorFields,
    pageLimitProbes,
    headerSnapshots,
  };

  logger.info(
    {
      selectedEndpoint,
      alternateEndpoints: discoveryResult.alternateEndpoints,
      authenticated,
      paginationDetected,
      cursorFields,
      firstPageRecords: records.length,
      pageLimitProbes,
    },
    "discovery summary",
  );

  return discoveryResult;
}

async function probePageLimits(
  client: ApiClient,
  logger: Logger,
  endpoint: string,
  headerSnapshots: HeaderSnapshot[],
): Promise<PageLimitProbe[]> {
  const probes: PageLimitProbe[] = [];

  for (const limit of LIMIT_PROBES) {
    const response = await client.probe(endpoint, { limit });

    headerSnapshots.push({
      endpoint: `${endpoint}?limit=${limit}`,
      status: response.status,
      headers: response.headers,
    });

    const returnedRecords = extractRecords(response.data).length;

    probes.push({
      requestedLimit: limit,
      status: response.status,
      returnedRecords,
    });

    logger.info(
      {
        endpoint,
        requestedLimit: limit,
        status: response.status,
        returnedRecords,
        headers: response.headers,
      },
      "discovery page-size probe",
    );

    if (response.status === 400 || response.status === 413) {
      break;
    }
  }

  return probes;
}

function detectPagination(data: unknown): boolean {
  if (!isObject(data)) {
    return false;
  }

  const knownKeys = ["hasMore", "nextCursor", "cursor", "next", "page", "pageToken"];

  if (knownKeys.some((key) => key in data)) {
    return true;
  }

  const paginationNode = data.pagination;

  if (!isObject(paginationNode)) {
    return false;
  }

  return knownKeys.some((key) => key in paginationNode);
}

function detectCursorFields(data: unknown): string[] {
  if (!isObject(data)) {
    return [];
  }

  const knownCursorLikeKeys = [
    "cursor",
    "nextCursor",
    "previousCursor",
    "next",
    "pageToken",
    "nextPageToken",
  ];

  const matches = new Set<string>();

  for (const key of Object.keys(data)) {
    if (knownCursorLikeKeys.includes(key)) {
      matches.add(key);
    }
  }

  const paginationNode = data.pagination;

  if (isObject(paginationNode)) {
    for (const key of Object.keys(paginationNode)) {
      if (knownCursorLikeKeys.includes(key)) {
        matches.add(`pagination.${key}`);
      }
    }
  }

  return Array.from(matches);
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
