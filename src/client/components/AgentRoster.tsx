import { AGENT_PROFILES, type AgentView } from '../../shared/types';
import { AgentAvatar } from './AgentAvatar';
import { Panel } from './Panel';
import { StatusBadge } from './StatusBadge';

interface AgentRosterProps {
  agents: AgentView[];
}

export function AgentRoster({ agents }: AgentRosterProps) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));

  return (
    <Panel title="Floor Crew" eyebrow="Presence & activity" count={AGENT_PROFILES.length} className="roster-panel">
      <ul className="agent-roster">
        {AGENT_PROFILES.map((profile) => {
          const agent = byId.get(profile.id);
          const status = agent?.status ?? 'offline';
          return (
            <li key={profile.id} className={`agent-row is-${status}`} title={agent?.message ?? agent?.activity}>
              <AgentAvatar agentId={profile.id} status={status} size={44} showStatus />
              <div className="agent-row-copy">
                <div className="agent-row-name">
                  <strong>{profile.name}</strong>
                  <span className="agent-row-title">{profile.title}</span>
                </div>
                <p className="agent-row-activity">{agent?.activity ?? 'Connecting to presence feed…'}</p>
                <div className="agent-row-meta">
                  <StatusBadge status={status} pulse={status === 'working' || status === 'thinking'} />
                  {agent && agent.completedTasks > 0 ? (
                    <span className="agent-delivered">{agent.completedTasks} delivered</span>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
