import pino, { type Logger } from 'pino';
import type { AppConfig } from './config';

export type OfficeLogger = Logger;

export function createLogger(config: Pick<AppConfig, 'logLevel' | 'nodeEnv'>): OfficeLogger {
  const pretty = config.nodeEnv !== 'production';
  return pino({
    level: config.logLevel,
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss.l',
              ignore: 'pid,hostname',
              singleLine: true,
            },
          },
        }
      : {}),
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-office-token"]',
        'token',
        '*.token',
        'req.query.token',
      ],
      censor: '[redacted]',
    },
  });
}

export function createTestLogger(): OfficeLogger {
  return pino({ level: 'silent' });
}
