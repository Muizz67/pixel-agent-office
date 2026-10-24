import { resolve } from 'node:path';
import { buildApp } from './app';
import { createConfig, isLoopbackHost } from './config';
import { createLogger } from './logger';
import { createOffice } from './office';

function loadDotEnv(): void {
  try {
    process.loadEnvFile(resolve(process.cwd(), '.env'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = createConfig();
  const logger = createLogger(config);
  const runtime = createOffice(config, logger);
  const app = await buildApp(runtime);

  if (!isLoopbackHost(config.host) && !config.officeApiToken) {
    logger.warn(
      'The office is bound to a non-loopback host without OFFICE_API_TOKEN. Set a token before exposing it.',
    );
  }
  if (runtime.provider.kind === 'mock') {
    logger.info(
      'Running with the local mock provider. Set OPENAI_API_KEY for live model execution.',
    );
  }

  const shutdown = (() => {
    let started = false;
    return async (reason: string): Promise<void> => {
      if (started) return;
      started = true;
      logger.info({ reason }, 'Shutting down office');
      const force = setTimeout(() => {
        logger.fatal('Graceful shutdown timed out; forcing exit.');
        process.exit(1);
      }, 15_000);
      force.unref?.();
      try {
        await app.close();
        await runtime.close();
        clearTimeout(force);
        process.exit(0);
      } catch (error) {
        logger.error({ err: error }, 'Graceful shutdown failed');
        clearTimeout(force);
        process.exit(1);
      }
    };
  })();

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
  });

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    logger.fatal({ err: error }, 'Could not start the office server');
    await runtime.close().catch(() => undefined);
    process.exit(1);
  }

  const displayHost = isLoopbackHost(config.host) ? 'localhost' : config.host;
  logger.info(
    {
      url: `http://${displayHost}:${config.port}`,
      provider: runtime.provider.kind,
      database: config.dbPath,
      workspaces: config.workspaceRoot,
      apiToken: Boolean(config.officeApiToken),
      shellTools: config.enableShellTools,
      fetchTool: config.enableFetchTool,
    },
    'Pixel Agent Office is online',
  );
  logger.info(
    'Dev UI: http://localhost:5173 · Production UI is served automatically after `npm run build`.',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
