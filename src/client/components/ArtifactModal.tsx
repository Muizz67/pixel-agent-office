import { useEffect, useRef, useState } from 'react';
import { AGENT_PROFILE_MAP, type Artifact } from '../../shared/types';
import { formatClock } from '../../shared/format';

export interface ArtifactPreview {
  artifact: Artifact;
  content: string | null;
  loading: boolean;
  error: string | null;
}

interface ArtifactModalProps {
  preview: ArtifactPreview;
  onClose: () => void;
  onRetry: () => void;
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

export function ArtifactModal({ preview, onClose, onRetry }: ArtifactModalProps) {
  const { artifact, content, loading, error } = preview;
  const closeRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  const profile = artifact.agentId ? AGENT_PROFILE_MAP[artifact.agentId] : null;

  useEffect(() => {
    closeRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    setCopied(false);
  }, [artifact.id]);

  const copy = async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="artifact-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="artifact-modal-title"
      >
        <header className="artifact-modal-head">
          <div className="artifact-modal-title">
            <span className="modal-kicker">Artifact preview</span>
            <h2 id="artifact-modal-title" title={artifact.path}>
              {baseName(artifact.path)}
            </h2>
            <p className="artifact-modal-path">{artifact.path}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="button button-ghost button-icon modal-close"
            onClick={onClose}
            aria-label="Close artifact preview"
          >
            ✕
          </button>
        </header>

        <div className="artifact-modal-meta">
          <span>
            <em>Mission</em> {artifact.runId}
          </span>
          {profile ? (
            <span>
              <em>Author</em> {profile.name}
            </span>
          ) : null}
          <span>
            <em>Size</em> {formatBytes(artifact.bytes)}
          </span>
          <span>
            <em>Saved</em> {formatClock(artifact.createdAt)}
          </span>
        </div>

        <div className="code-toolbar">
          <span className="code-language">UTF-8 · text</span>
          <button
            type="button"
            className="button button-ghost button-tiny"
            onClick={() => void copy()}
            disabled={!content}
          >
            {copied ? 'Copied' : 'Copy content'}
          </button>
        </div>

        <div className="code-shell">
          {loading ? (
            <div className="modal-state" role="status">
              <span className="pixel-loader" aria-hidden="true" />
              Reading artifact from the sandbox…
            </div>
          ) : error ? (
            <div className="modal-state is-error" role="alert">
              <p>{error}</p>
              <button type="button" className="button button-ghost button-small" onClick={onRetry}>
                Retry
              </button>
            </div>
          ) : (
            <pre className="code-view">{content}</pre>
          )}
        </div>

        <footer className="artifact-modal-foot">
          <span>Files are served read-only from the mission sandbox.</span>
          <button type="button" className="button button-ghost button-small" onClick={onClose}>
            Close
          </button>
        </footer>
      </section>
    </div>
  );
}
