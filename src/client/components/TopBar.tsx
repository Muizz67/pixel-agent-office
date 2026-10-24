import type { PublicConfig, Run } from '../../shared/types';
import type { ConnectionState } from '../useRunStream';
import { StatusBadge } from './StatusBadge';

interface TopBarProps {
  config: PublicConfig | null;
  connection: ConnectionState;
  activeRun: Run | null;
  viewingLive: boolean;
  syncing: boolean;
  onSync: () => void;
}

const CONNECTION_LABELS: Record<ConnectionState, string> = {
  idle: 'Standby',
  connecting: 'Linking',
  live: 'Live feed',
  reconnecting: 'Reconnecting',
  offline: 'Feed offline',
};

export function TopBar({
  config,
  connection,
  activeRun,
  viewingLive,
  syncing,
  onSync,
}: TopBarProps) {
  const provider = config?.provider;
  const liveModel = provider?.live ?? false;

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">
          {Array.from({ length: 9 }, (_, index) => (
            <i key={index} />
          ))}
        </div>
        <div className="brand-copy">
          <h1>Pixel Agent Office</h1>
          <p>CEO-led multi-agent workspace</p>
        </div>
      </div>

      <div className="topbar-meta" aria-label="Office status">
        <span className={`connection-pill is-${connection}`}>
          <span className="connection-bars" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          {CONNECTION_LABELS[connection]}
        </span>

        {provider ? (
          <span className={`provider-pill ${liveModel ? 'is-live' : 'is-mock'}`} title={`Planner: ${provider.plannerModel}`}>
            <span className="provider-led" aria-hidden="true" />
            {liveModel ? 'Live model' : 'Simulation'}
          </span>
        ) : null}

        {provider ? <span className="model-chip">{provider.workerModel}</span> : null}
      </div>

      <div className="topbar-actions">
        {activeRun ? (
          <div className="mission-pill">
            <StatusBadge status={activeRun.status} pulse />
            <span className="mission-pill-label">
              {viewingLive ? 'On the floor' : 'Mission in progress'}
            </span>
          </div>
        ) : (
          <span className="floor-idle">
            <span className="floor-idle-dot" aria-hidden="true" />
            Floor idle
          </span>
        )}
        <button
          type="button"
          className="button button-ghost button-icon"
          onClick={onSync}
          disabled={syncing}
          title="Sync office state"
        >
          <span className={syncing ? 'sync-icon is-spinning' : 'sync-icon'} aria-hidden="true">
            ↻
          </span>
          <span className="button-label">Sync</span>
        </button>
      </div>
    </header>
  );
}
