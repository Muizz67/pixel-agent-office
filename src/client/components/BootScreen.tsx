interface BootScreenProps {
  error: string | null;
  busy: boolean;
  onRetry: () => void;
}

const BOOT_LINES = ['sqlite://office.db', 'presence://floor-01', 'stream://events', 'sandbox://missions'];

export function BootScreen({ error, busy, onRetry }: BootScreenProps) {
  return (
    <div className="auth-screen boot-screen">
      <div className="auth-grid" aria-hidden="true" />
      <div className="boot-card">
        <div className="brand-mark brand-mark-large" aria-hidden="true">
          {Array.from({ length: 9 }, (_, index) => (
            <i key={index} />
          ))}
        </div>
        <span className="auth-kicker">Pixel Agent Office</span>
        <h1>{error ? 'Boot failed' : 'Opening the floor'}</h1>

        {error ? (
          <>
            <p className="boot-error" role="alert">
              {error}
            </p>
            <button type="button" className="button button-primary" onClick={onRetry} disabled={busy}>
              {busy ? 'Retrying…' : 'Retry boot'}
            </button>
          </>
        ) : (
          <>
            <p className="boot-copy">Waking the CEO, linking the presence feed, and loading the archive.</p>
            <div className="boot-progress" aria-hidden="true">
              <span />
            </div>
            <ul className="boot-log">
              {BOOT_LINES.map((line) => (
                <li key={line}>
                  <span className="boot-check" aria-hidden="true">
                    ▸
                  </span>
                  {line}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
