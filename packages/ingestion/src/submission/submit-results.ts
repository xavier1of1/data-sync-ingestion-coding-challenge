import { createReadStream } from "node:fs";

import axios from "axios";
import type { Logger } from "pino";

import type { AppConfig } from "../types";

export async function submitResults(
  config: AppConfig,
  filePath: string,
  logger: Logger,
): Promise<{ submitted: boolean; responseData: unknown | null }> {
  if (!config.githubRepoUrl) {
    logger.info("github repo url not set; skipping submission");
    return {
      submitted: false,
      responseData: null,
    };
  }

  const submissionsUrl = `${config.apiBaseUrl.replace(/\/$/, "")}/submissions`;
  const payload = createReadStream(filePath);

  const response = await axios.post(submissionsUrl, payload, {
    params: {
      github_repo: config.githubRepoUrl,
    },
    headers: {
      "X-API-Key": config.targetApiKey,
      "Content-Type": "text/plain",
    },
    maxBodyLength: Infinity,
    timeout: config.apiRequestTimeoutMs,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`submission failed with status ${response.status}: ${JSON.stringify(response.data)}`);
  }

  logger.info({ status: response.status }, "submission request complete");

  return {
    submitted: true,
    responseData: response.data,
  };
}
