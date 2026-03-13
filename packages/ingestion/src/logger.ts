import pino, { type Logger } from "pino";

import type { AppConfig } from "./types";

export function createLogger(config: AppConfig): Logger {
  return pino({
    name: config.applicationName,
    level: config.logLevel,
    base: {
      service: config.applicationName,
      environment: config.nodeEnv,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
