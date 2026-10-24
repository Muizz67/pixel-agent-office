import { useRef, useState, type FormEvent } from 'react';

interface AuthGateProps {
  busy: boolean;
  error: string | null;
  onSubmit: (token: string) => Promise<void>;
}

export function AuthGate({ busy, error, onSubmit }: AuthGateProps) {
  const [token, setToken] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!token.trim() || busy) return;
    void onSubmit(token.trim());
  };

  return (
    <div className="auth-screen">
      <div className="auth-grid" aria-hidden="true" />
      <div className="auth-card">
        <div className="auth-brand">
          <div className="brand-mark brand-mark-large" aria-hidden="true">
            {Array.from({ length: 9 }, (_, index) => (
              <i key={index} />
            ))}
          </div>
          <span className="auth-kicker">Pixel Agent Office</span>
        </div>

        <div className="auth-lock" aria-hidden="true">
          <span className="auth-lock-shackle" />
          <span className="auth-lock-body">
            <i />
          </span>
        </div>

        <h1>Office locked</h1>
        <p className="auth-copy">
          This floor requires an access token. Paste the <code>OFFICE_API_TOKEN</code> shared by the
          operator. It is stored in this browser tab only.
        </p>

        <form onSubmit={submit} className="auth-form">
          <label htmlFor="office-token">Access token</label>
          <input
            ref={inputRef}
            id="office-token"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="••••••••••••••••"
            autoComplete="current-password"
            autoFocus
            disabled={busy}
          />
          {error ? (
            <p className="auth-error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" className="button button-primary auth-submit" disabled={busy || !token.trim()}>
            {busy ? 'Verifying…' : 'Enter the office'}
          </button>
        </form>

        <p className="auth-hint">
          Tip: the server also accepts <code>?token=…</code> once in the URL and keeps it in
          sessionStorage.
        </p>
      </div>
    </div>
  );
}
