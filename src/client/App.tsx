import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  isRunActive,
  type AnyRunEvent,
  type Approval,
  type Artifact,
  type BootstrapResponse,
  type PublicConfig,
} from '../shared/types';
import { api, ApiError, captureTokenFromUrl, getOfficeToken, setOfficeToken } from './api';
import { ActivityFeed } from './components/ActivityFeed';
import { AgentRoster } from './components/AgentRoster';
import { ApprovalPanel } from './components/ApprovalPanel';
import { ArtifactModal, type ArtifactPreview } from './components/ArtifactModal';
import { AuthGate } from './components/AuthGate';
import { BootScreen } from './components/BootScreen';
import { Deliverables } from './components/Deliverables';
import { MissionPanel } from './components/MissionPanel';
import { OfficeStage } from './components/OfficeStage';
import { RunHistory } from './components/RunHistory';
import { TaskBoard } from './components/TaskBoard';
import { TopBar } from './components/TopBar';
import {
  EMPTY_VIEW,
  applyRunEvent,
  applySnapshot,
  isTerminalEvent,
  lastEventSeq,
  mergeRun,
  selectRunInState,
  upsert,
  type OfficeViewState,
} from './officeState';
import { useRunStream } from './useRunStream';

type ToastKind = 'info' | 'success' | 'error';

interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'The office could not complete that request.';
}

export default function App() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [view, setView] = useState<OfficeViewState>(EMPTY_VIEW);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [streamAfter, setStreamAfter] = useState(0);
  const [starting, setStarting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [refreshingRuns, setRefreshingRuns] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const selectionRef = useRef(0);

  const notify = useCallback((text: string, kind: ToastKind = 'info') => {
    setToast({ id: Date.now() + Math.random(), kind, text });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => {
      setToast((current) => (current?.id === toast.id ? null : current));
    }, 4_500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const loadSnapshot = useCallback(
    async (runId: string) => {
      const token = ++selectionRef.current;
      setView((current) => selectRunInState(current, runId));
      setSnapshotLoading(true);
      try {
        const snapshot = await api.getRun(runId);
        if (token !== selectionRef.current) return;
        setView((current) => applySnapshot(current, snapshot));
        setStreamAfter(lastEventSeq(snapshot));
      } catch (error) {
        if (token !== selectionRef.current) return;
        if (error instanceof ApiError && error.status === 401) {
          setAuthRequired(true);
          setAuthError('Your session token was rejected.');
          return;
        }
        if (error instanceof ApiError && error.status === 404) {
          setView((current) => ({ ...current, selectedRunId: null, snapshot: null }));
          notify('That mission is no longer available.', 'error');
          return;
        }
        notify(errorText(error), 'error');
      } finally {
        if (token === selectionRef.current) setSnapshotLoading(false);
      }
    },
    [notify],
  );

  const hydrate = useCallback(
    async (data: BootstrapResponse, preferredRunId?: string | null) => {
      setConfig(data.config);
      setView((current) => ({ ...current, agents: data.agents, runs: data.runs }));
      const target =
        preferredRunId && data.runs.some((run) => run.id === preferredRunId)
          ? preferredRunId
          : data.activeRun?.id ?? data.runs[0]?.id ?? null;
      if (target) {
        await loadSnapshot(target);
      } else {
        setView((current) => ({ ...current, selectedRunId: null, snapshot: null }));
        setStreamAfter(0);
      }
    },
    [loadSnapshot],
  );

  const bootstrap = useCallback(async () => {
    setBooting(true);
    setBootError(null);
    try {
      const data = await api.bootstrap();
      setAuthRequired(false);
      setAuthError(null);
      await hydrate(data);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setAuthRequired(true);
      } else {
        setBootError(errorText(error));
      }
    } finally {
      setBooting(false);
    }
  }, [hydrate]);

  useEffect(() => {
    captureTokenFromUrl();
    void bootstrap();
  }, [bootstrap]);

  const handleAuth = useCallback(
    async (token: string) => {
      setOfficeToken(token);
      setAuthBusy(true);
      setAuthError(null);
      try {
        const data = await api.bootstrap();
        await hydrate(data);
        setAuthRequired(false);
      } catch (error) {
        setOfficeToken('');
        setAuthError(errorText(error));
      } finally {
        setAuthBusy(false);
      }
    },
    [hydrate],
  );

  const handleUnauthorized = useCallback(() => {
    setAuthRequired(true);
    setAuthError('Your session token was rejected. Re-enter it to reconnect.');
  }, []);

  const handleEvent = useCallback(
    (event: AnyRunEvent) => {
      setView((current) => applyRunEvent(current, event));
      if (event.type === 'run.completed') {
        notify('Mission completed. The debrief is ready.', 'success');
      } else if (event.type === 'run.failed') {
        notify('Mission failed. Check the activity feed.', 'error');
      } else if (event.type === 'run.interrupted') {
        notify('Mission interrupted. Resume it from the mission panel.', 'info');
      }

      if (isTerminalEvent(event)) {
        window.setTimeout(() => {
          void api
            .listRuns(20)
            .then((result) => setView((current) => ({ ...current, runs: result.runs })))
            .catch(() => {
              // A later sync can recover the archive.
            });
        }, 600);
      }
    },
    [notify],
  );

  const refreshRuns = useCallback(async () => {
    setRefreshingRuns(true);
    try {
      const result = await api.listRuns(20);
      setView((current) => ({ ...current, runs: result.runs }));
    } catch (error) {
      notify(errorText(error), 'error');
    } finally {
      setRefreshingRuns(false);
    }
  }, [notify]);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      const data = await api.bootstrap();
      setConfig(data.config);
      setView((current) => ({ ...current, agents: data.agents, runs: data.runs }));
      const target =
        view.selectedRunId && data.runs.some((run) => run.id === view.selectedRunId)
          ? view.selectedRunId
          : data.activeRun?.id ?? data.runs[0]?.id ?? null;
      if (target) await loadSnapshot(target);
      notify('Office synced.', 'info');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setAuthRequired(true);
      } else {
        notify(errorText(error), 'error');
      }
    } finally {
      setSyncing(false);
    }
  }, [loadSnapshot, notify, view.selectedRunId]);

  const handleStart = useCallback(
    async (goal: string, maxTasks?: number): Promise<boolean> => {
      if (starting) return false;
      setStarting(true);
      try {
        const { run } = await api.startRun(goal, maxTasks);
        setView((current) => ({
          ...current,
          runs: mergeRun(current.runs, run),
          selectedRunId: run.id,
        }));
        await loadSnapshot(run.id);
        notify('Mission dispatched. The CEO is planning.', 'info');
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          setAuthRequired(true);
        } else {
          notify(errorText(error), 'error');
          if (error instanceof ApiError && error.status === 409) {
            void api
              .listRuns(20)
              .then((result) => setView((current) => ({ ...current, runs: result.runs })))
              .catch(() => {});
          }
        }
        return false;
      } finally {
        setStarting(false);
      }
    },
    [loadSnapshot, notify, starting],
  );

  const handleCancel = useCallback(
    async (runId: string) => {
      try {
        await api.cancelRun(runId);
        await loadSnapshot(runId);
        notify('Mission cancelled.', 'info');
      } catch (error) {
        notify(errorText(error), 'error');
      }
    },
    [loadSnapshot, notify],
  );

  const handleResume = useCallback(
    async (runId: string) => {
      try {
        const { run } = await api.resumeRun(runId);
        setView((current) => ({ ...current, runs: mergeRun(current.runs, run) }));
        await loadSnapshot(runId);
        notify('Mission resumed. Requeued work is on the floor.', 'info');
      } catch (error) {
        notify(errorText(error), 'error');
      }
    },
    [loadSnapshot, notify],
  );

  const handleResolveApproval = useCallback(
    async (approvalId: string, decision: 'approve' | 'deny', note?: string): Promise<boolean> => {
      const runId = view.selectedRunId;
      if (!runId) return false;
      try {
        const { approval }: { approval: Approval } = await api.resolveApproval(
          runId,
          approvalId,
          decision,
          note,
        );
        setView((current) =>
          current.snapshot
            ? {
                ...current,
                snapshot: {
                  ...current.snapshot,
                  approvals: upsert(current.snapshot.approvals, approval, (item) => item.id),
                },
              }
            : current,
        );
        notify(
          decision === 'approve' ? 'Approval granted. The agent is continuing.' : 'Approval denied.',
          decision === 'approve' ? 'success' : 'info',
        );
        return true;
      } catch (error) {
        notify(errorText(error), 'error');
        return false;
      }
    },
    [notify, view.selectedRunId],
  );

  const openArtifact = useCallback(async (artifact: Artifact) => {
    setPreview({ artifact, content: null, loading: true, error: null });
    try {
      const result = await api.getArtifactContent(artifact.runId, artifact.path);
      setPreview((current) =>
        current && current.artifact.id === artifact.id
          ? { ...current, content: result.content, loading: false }
          : current,
      );
    } catch (error) {
      setPreview((current) =>
        current && current.artifact.id === artifact.id
          ? { ...current, loading: false, error: errorText(error) }
          : current,
      );
    }
  }, []);

  const retryPreview = useCallback(() => {
    if (preview) void openArtifact(preview.artifact);
  }, [openArtifact, preview]);

  const closePreview = useCallback(() => setPreview(null), []);

  const snapshot = view.snapshot && view.snapshot.run.id === view.selectedRunId ? view.snapshot : null;
  const viewRun = snapshot?.run ?? view.runs.find((run) => run.id === view.selectedRunId) ?? null;
  const tasks = snapshot?.tasks ?? [];
  const approvals = snapshot?.approvals ?? [];
  const artifacts = snapshot?.artifacts ?? [];
  const events = snapshot?.events ?? [];

  const activeRun = useMemo(
    () =>
      view.runs.find((run) => isRunActive(run.status)) ??
      (view.snapshot && isRunActive(view.snapshot.run.status) ? view.snapshot.run : null),
    [view.runs, view.snapshot],
  );
  const viewingLive = Boolean(activeRun && viewRun && activeRun.id === viewRun.id);
  const streamEnabled = Boolean(viewRun && isRunActive(viewRun.status) && !snapshotLoading);

  const connection = useRunStream({
    runId: view.selectedRunId,
    enabled: streamEnabled,
    after: streamAfter,
    token: getOfficeToken(),
    onEvent: handleEvent,
    onUnauthorized: handleUnauthorized,
  });

  if (authRequired) {
    return <AuthGate busy={authBusy || booting} error={authError} onSubmit={handleAuth} />;
  }

  if (!config) {
    return <BootScreen error={bootError} busy={booting} onRetry={() => void bootstrap()} />;
  }

  return (
    <div className="app-shell">
      <TopBar
        config={config}
        connection={connection}
        activeRun={activeRun}
        viewingLive={viewingLive}
        syncing={syncing}
        onSync={() => void handleSync()}
      />

      <main className="workspace">
        <aside className="rail rail-left" aria-label="Mission controls">
          <MissionPanel
            config={config}
            activeRun={activeRun}
            viewRun={viewRun}
            viewTasks={tasks}
            starting={starting}
            onStart={handleStart}
            onCancel={handleCancel}
            onResume={handleResume}
            onViewLive={(runId) => void loadSnapshot(runId)}
          />
          <AgentRoster agents={view.agents} />
          <RunHistory
            runs={view.runs}
            selectedRunId={view.selectedRunId}
            onSelect={(runId) => void loadSnapshot(runId)}
            onRefresh={() => void refreshRuns()}
            refreshing={refreshingRuns}
          />
        </aside>

        <div className="center-column">
          <OfficeStage
            run={viewRun}
            agents={view.agents}
            tasks={tasks}
            connection={connection}
            viewingLive={viewingLive}
            loading={snapshotLoading}
          />
          <TaskBoard run={viewRun} tasks={tasks} />
        </div>

        <aside className="rail rail-right" aria-label="Mission output">
          <ApprovalPanel run={viewRun} approvals={approvals} onResolve={handleResolveApproval} />
          <Deliverables run={viewRun} artifacts={artifacts} onPreview={(artifact) => void openArtifact(artifact)} />
          <ActivityFeed
            events={events}
            run={viewRun}
            active={Boolean(viewRun && isRunActive(viewRun.status))}
          />
        </aside>
      </main>

      <footer className="app-footer">
        <span>
          <span className="footer-mark" aria-hidden="true" />
          Pixel Agent Office v{config.version}
        </span>
        <span className="footer-sep">/</span>
        <span>{config.provider.label}</span>
        <span className="footer-sep">/</span>
        <span>sandboxed workspaces</span>
        <span className="footer-sep">/</span>
        <span>{config.features.shellTools ? 'shell armed' : 'shell locked'}</span>
        <span className="footer-sep">/</span>
        <span>{config.features.approvals ? 'approvals on' : 'approvals off'}</span>
        <span className="footer-spacer" />
        <span className="footer-mono">FLOOR 01 · {config.limits.maxConcurrentTasks} CONCURRENT</span>
      </footer>

      {toast ? (
        <div className={`toast is-${toast.kind}`} role="status">
          <span className="toast-mark" aria-hidden="true">
            {toast.kind === 'success' ? '✓' : toast.kind === 'error' ? '✕' : '◆'}
          </span>
          <span>{toast.text}</span>
          <button
            type="button"
            className="toast-close"
            onClick={() => setToast(null)}
            aria-label="Dismiss notification"
          >
            ✕
          </button>
        </div>
      ) : null}

      {preview ? (
        <ArtifactModal preview={preview} onClose={closePreview} onRetry={retryPreview} />
      ) : null}
    </div>
  );
}
