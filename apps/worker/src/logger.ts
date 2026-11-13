import pino from 'pino';
import type { Env } from '@pms/config';

/** The slice of a pino logger the worker uses, so tests can pass a silent one. */
export interface Logger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  debug(obj: Record<string, unknown>, msg?: string): void;
}

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

export function createLogger(env: Env): Logger {
  return pino({
    name: 'worker',
    level: env.LOG_LEVEL ?? 'info',
    ...(env.isProduction
      ? {}
      : {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }),
  });
}
