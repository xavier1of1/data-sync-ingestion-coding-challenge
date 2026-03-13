import http from "node:http";
import https from "node:https";
import { setTimeout as delay } from "node:timers/promises";

import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
} from "axios";
import type { Logger } from "pino";

import type { AppConfig } from "../types";

const HTTP_AGENT = new http.Agent({
  keepAlive: true,
  maxSockets: 32,
});

const HTTPS_AGENT = new https.Agent({
  keepAlive: true,
  maxSockets: 32,
});

export interface ApiRequestOptions {
  maxAttempts: number;
}

export interface ApiRequestResult {
  endpoint: string;
  status: number;
  headers: Record<string, string>;
  data: unknown;
}

export class ApiError extends Error {
  public readonly status: number | null;
  public readonly headers: Record<string, string>;
  public readonly retriable: boolean;
  public readonly staleCursor: boolean;
  public readonly retryAfterMs: number | null;

  public constructor(params: {
    message: string;
    status: number | null;
    headers?: Record<string, string>;
    retriable: boolean;
    staleCursor: boolean;
    retryAfterMs?: number | null;
  }) {
    super(params.message);
    this.name = "ApiError";
    this.status = params.status;
    this.headers = params.headers ?? {};
    this.retriable = params.retriable;
    this.staleCursor = params.staleCursor;
    this.retryAfterMs = params.retryAfterMs ?? null;
  }
}

export class ApiClient {
  private readonly http: AxiosInstance;
  private nextAllowedRequestAtMs = 0;

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.http = axios.create({
      baseURL: config.apiBaseUrl,
      timeout: config.apiRequestTimeoutMs,
      headers: {
        "X-API-Key": config.targetApiKey,
        "Accept-Encoding": "gzip, deflate, br",
      },
      httpAgent: HTTP_AGENT,
      httpsAgent: HTTPS_AGENT,
      validateStatus: () => true,
    });
  }

  public async probe(endpoint: string, params: Record<string, unknown> = {}): Promise<ApiRequestResult> {
    const response = await this.sendRaw(endpoint, params);
    this.applyRateLimitWindow(response.status, response.headers);

    return {
      endpoint,
      status: response.status,
      headers: response.headers,
      data: response.data,
    };
  }

  public async getWithRetry(
    endpoint: string,
    params: Record<string, unknown>,
    options: ApiRequestOptions,
  ): Promise<ApiRequestResult> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt < options.maxAttempts) {
      attempt += 1;

      await this.waitForRateLimitWindow();

      try {
        const response = await this.sendRaw(endpoint, params);
        this.applyRateLimitWindow(response.status, response.headers);

        if (response.status >= 200 && response.status < 300) {
          return {
            endpoint,
            status: response.status,
            headers: response.headers,
            data: response.data,
          };
        }

        const apiError = this.buildApiError(response);

        if (!apiError.retriable || attempt >= options.maxAttempts) {
          throw apiError;
        }

        const retryDelay = this.computeRetryDelay(attempt, apiError.retryAfterMs);

        this.logger.warn(
          {
            endpoint,
            status: response.status,
            attempt,
            maxAttempts: options.maxAttempts,
            retryDelay,
          },
          "transient API status, retrying",
        );

        await delay(retryDelay);
      } catch (error) {
        if (error instanceof ApiError) {
          throw error;
        }

        const networkError = this.buildNetworkError(error);

        if (!networkError.retriable || attempt >= options.maxAttempts) {
          throw networkError;
        }

        const retryDelay = this.computeRetryDelay(attempt, networkError.retryAfterMs);

        this.logger.warn(
          {
            endpoint,
            attempt,
            maxAttempts: options.maxAttempts,
            retryDelay,
            err: error,
          },
          "transient API/network error, retrying",
        );

        await delay(retryDelay);
        lastError = error;
      }
    }

    throw (
      lastError ??
      new ApiError({
        message: "API request failed without explicit error",
        status: null,
        retriable: false,
        staleCursor: false,
      })
    );
  }

  private async sendRaw(
    endpoint: string,
    params: Record<string, unknown>,
  ): Promise<{ status: number; headers: Record<string, string>; data: unknown }> {
    const requestConfig: AxiosRequestConfig = {
      params,
    };

    const response = await this.http.get(endpoint, requestConfig);
    const headers = normalizeHeaders(response.headers as Record<string, unknown>);

    this.logger.debug(
      {
        endpoint,
        status: response.status,
        params,
        headers,
      },
      "api response",
    );

    return {
      status: response.status,
      headers,
      data: response.data,
    };
  }

  private buildApiError(response: {
    status: number;
    headers: Record<string, string>;
    data: unknown;
  }): ApiError {
    const retryAfterMs = readRetryAfterMs(response.headers);
    const bodyText = JSON.stringify(response.data ?? {}).toLowerCase();
    const staleCursor =
      response.status >= 400 &&
      response.status < 500 &&
      bodyText.includes("cursor") &&
      (bodyText.includes("invalid") || bodyText.includes("expired") || bodyText.includes("stale"));

    const retriableStatuses = new Set([429, 500, 502, 503, 504]);

    return new ApiError({
      message: `API request failed with status ${response.status}`,
      status: response.status,
      headers: response.headers,
      retriable: retriableStatuses.has(response.status),
      staleCursor,
      retryAfterMs,
    });
  }

  private buildNetworkError(error: unknown): ApiError {
    const asAxios = error as AxiosError | undefined;
    const code = asAxios?.code ?? "UNKNOWN";

    return new ApiError({
      message: `API network error (${code})`,
      status: null,
      retriable: true,
      staleCursor: false,
      retryAfterMs: null,
    });
  }

  private computeRetryDelay(attempt: number, retryAfterMs: number | null): number {
    if (retryAfterMs && retryAfterMs > 0) {
      return retryAfterMs;
    }

    const exponential = this.config.retryBaseDelayMs * 2 ** (attempt - 1);
    const jitter = Math.floor(Math.random() * this.config.retryBaseDelayMs);
    return Math.min(exponential + jitter, this.config.retryMaxDelayMs);
  }

  private async waitForRateLimitWindow(): Promise<void> {
    const now = Date.now();

    if (this.nextAllowedRequestAtMs <= now) {
      return;
    }

    const waitMs = this.nextAllowedRequestAtMs - now;

    this.logger.debug({ waitMs }, "waiting for rate-limit window");
    await delay(waitMs);
  }

  private applyRateLimitWindow(status: number, headers: Record<string, string>): void {
    const retryAfterMs = readRetryAfterMs(headers);

    if (status === 429 && retryAfterMs) {
      this.bumpNextAllowedRequestAt(retryAfterMs);
      return;
    }

    const remainingRaw = headers["x-ratelimit-remaining"];
    const resetRaw = headers["x-ratelimit-reset"];

    if (remainingRaw === "0" && resetRaw) {
      const resetSeconds = Number(resetRaw);

      if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
        this.bumpNextAllowedRequestAt(resetSeconds * 1000);
      }
    }
  }

  private bumpNextAllowedRequestAt(delayMs: number): void {
    const candidate = Date.now() + delayMs;
    this.nextAllowedRequestAtMs = Math.max(this.nextAllowedRequestAtMs, candidate);
  }
}

function readRetryAfterMs(headers: Record<string, string>): number | null {
  const retryAfter = headers["retry-after"];

  if (!retryAfter) {
    return null;
  }

  const numeric = Number(retryAfter);

  if (Number.isFinite(numeric) && numeric >= 0) {
    return Math.floor(numeric * 1000);
  }

  const parsedDate = Date.parse(retryAfter);

  if (Number.isNaN(parsedDate)) {
    return null;
  }

  return Math.max(parsedDate - Date.now(), 0);
}

function normalizeHeaders(headers: Record<string, unknown>): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "undefined" || value === null) {
      continue;
    }

    if (Array.isArray(value)) {
      normalized[key.toLowerCase()] = value.map((entry) => String(entry)).join(",");
      continue;
    }

    normalized[key.toLowerCase()] = String(value);
  }

  return normalized;
}
