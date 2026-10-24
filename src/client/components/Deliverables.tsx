import { AGENT_PROFILE_MAP, type Artifact, type Run } from '../../shared/types';
import { timeAgo } from '../../shared/format';
import { AgentAvatar } from './AgentAvatar';
import { Panel } from './Panel';

interface DeliverablesProps {
  run: Run | null;
  artifacts: Artifact[];
  onPreview: (artifact: Artifact) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

export function Deliverables({ run, artifacts, onPreview }: DeliverablesProps) {
  return (
    <Panel
      title="Deliverables"
      eyebrow="Debrief & artifacts"
      count={artifacts.length}
      className="deliverables-panel"
    >
      {run?.summary ? (
        <div className="debrief">
          <span className="debrief-label">CEO debrief</span>
          <p>{run.summary}</p>
        </div>
      ) : null}

      {run?.error ? (
        <div className="debrief is-error">
          <span className="debrief-label">Mission error</span>
          <p>{run.error}</p>
        </div>
      ) : null}

      {artifacts.length === 0 ? (
        <div className="deliverables-empty">
          <span aria-hidden="true">▤</span>
          <p>
            {run
              ? 'No artifacts yet. Files written by the crew will collect here.'
              : 'Artifacts from completed missions will collect here.'}
          </p>
        </div>
      ) : (
        <ul className="artifact-list">
          {artifacts.map((artifact) => {
            const profile = artifact.agentId ? AGENT_PROFILE_MAP[artifact.agentId] : null;
            return (
              <li key={artifact.id}>
                <button type="button" className="artifact-row" onClick={() => onPreview(artifact)}>
                  <span className="artifact-icon" aria-hidden="true">
                    ▤
                  </span>
                  <span className="artifact-copy">
                    <span className="artifact-name" title={artifact.path}>
                      {baseName(artifact.path)}
                    </span>
                    <span className="artifact-path">{artifact.path}</span>
                    <span className="artifact-meta">
                      {profile ? (
                        <>
                          <AgentAvatar agentId={artifact.agentId!} size={18} />
                          <span>{profile.name}</span>
                          <span className="artifact-sep">·</span>
                        </>
                      ) : null}
                      <span>{formatBytes(artifact.bytes)}</span>
                      <span className="artifact-sep">·</span>
                      <span>{timeAgo(artifact.createdAt)}</span>
                    </span>
                  </span>
                  <span className="artifact-open">View</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
