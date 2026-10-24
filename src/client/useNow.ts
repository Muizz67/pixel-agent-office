import { useEffect, useState } from 'react';

/**
 * Re-render on an interval so elapsed times stay honest without forcing the
 * whole app to re-render on every streamed event.
 */
export function useNow(enabled: boolean, intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, intervalMs]);

  return now;
}
