import { mkdirSync } from 'node:fs';
import type { Logger } from 'pino';
import type { AppConfig } from './config';
import { AgentPresence } from './agents';
import { ApprovalBroker } from './approvals';
import { createStores, OfficeDatabase, type Stores } from './db';
import { RunEventService } from './events';
import { createProviderBundle } from './llm/factory';
import type { ProviderBundle } from './llm/types';
import { OfficeOrchestrator } from './orchestrator';
import { ToolRegistry } from './tools/builtins';

export interface OfficeRuntime {
  config: AppConfig;
  logger: Logger;
  db: OfficeDatabase;
  stores: Stores;
  events: RunEventService;
  presence: AgentPresence;
  approvals: ApprovalBroker;
  provider: ProviderBundle;
  tools: ToolRegistry;
  orchestrator: OfficeOrchestrator;
  startedAt: number;
  close(): Promise<void>;
}

export function createOffice(config: AppConfig, logger: Logger): OfficeRuntime {
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.workspaceRoot, { recursive: true });
  const db = new OfficeDatabase(config.dbPath);
  const stores = createStores(db);
  const events = new RunEventService(stores.events);
  const presence = new AgentPresence(events);
  const approvals = new ApprovalBroker(stores.approvals, events);

  let provider: ProviderBundle;
  try {
    provider = createProviderBundle(config, logger);
  } catch (error) {
    db.close();
    throw error;
  }
  const tools = new ToolRegistry(config);
  const orchestrator = new OfficeOrchestrator({
    config,
    logger,
    stores,
    events,
    presence,
    approvals,
    provider,
    tools,
  });

  orchestrator.recoverFromRestart();

  const startedAt = Date.now();
  return {
    config,
    logger,
    db,
    stores,
    events,
    presence,
    approvals,
    provider,
    tools,
    orchestrator,
    startedAt,
    async close() {
      await orchestrator.shutdown();
      db.close();
    },
  };
}
