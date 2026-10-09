import { useEffect, useState, type ReactNode } from "react";
import { AudioLines, ChevronDown, RefreshCw, ShieldAlert, WifiOff } from "lucide-react";
import {
  diagnosticDeploymentName,
  getDiagnostics,
  installGlobalDiagnostics,
  subscribeDiagnostics,
  type DiagnosticEntry,
} from "@/lib/diagnostics";
import { PHASE_MESSAGES, statusCopy, type ServiceStatus } from "@/lib/service-status";
import { useServiceStatus, type ServiceStatusHandle } from "@/hooks/use-service-status";

/**
 * Themed fallbacks for every "not fully usable" state.
 *
 * Rules these components follow:
 *   - never render nothing (the black-screen failure mode),
 *   - always say what is happening and whether retrying can help,
 *   - never take over the screen for a state that the app can survive (those
 *     use the banner instead),
 *   - keep the Freecord look: dark surface, violet accent, same typography.
 */

function FreecordMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`fc-status-mark ${small ? "small" : ""}`}>
      <AudioLines strokeWidth={2.7} aria-hidden="true" />
      <span>
        freecord<span className="brand-period">.</span>
      </span>
    </span>
  );
}

/** First paint: auth/connection still resolving. Never blank. */
export function BrandSplash({ label = "Connecting to Freecord…" }: { label?: string }) {
  return (
    <div className="fc-status-shell" role="status" aria-live="polite">
      <div className="fc-status-card">
        <FreecordMark />
        <div className="fc-status-pulse" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p className="fc-status-label">{label}</p>
      </div>
    </div>
  );
}

function DiagnosticsDetails() {
  const [entries, setEntries] = useState<DiagnosticEntry[]>(() => getDiagnostics());
  const [open, setOpen] = useState(false);

  useEffect(() => subscribeDiagnostics(() => setEntries(getDiagnostics())), []);

  if (entries.length === 0) return null;

  return (
    <div className="fc-status-diagnostics">
      <button type="button" className="fc-status-diagnostics-toggle" onClick={() => setOpen((v) => !v)}>
        <ChevronDown className={open ? "rotated" : ""} aria-hidden="true" />
        Diagnostics ({entries.length})
      </button>
      {open && (
        <ul>
          {/* Which backend, and which function, each failure came from. */}
          <li className="fc-status-diagnostics-context">
            <strong>deployment</strong>
            <em>{diagnosticDeploymentName()}</em>
          </li>
          {entries.map((entry) => (
            <li key={`${entry.kind}:${entry.message}`}>
              <strong>{entry.kind}</strong>
              <span>×{entry.count}</span>
              <em>{entry.message}</em>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type ScreenProps = {
  handle: ServiceStatusHandle;
  children?: ReactNode;
};

/**
 * Full-screen state for a failure the user cannot work around, with a guarded
 * Retry. If `children` is provided they are rendered BELOW the notice so the
 * app shell stays visible whenever it is safe to do so.
 */
export function ServiceStatusScreen({ handle, children }: ScreenProps) {
  const { status, retry, cooldownRemainingMs } = handle;
  const copy = statusCopy(status);
  const waitSeconds = Math.ceil(cooldownRemainingMs / 1000);
  const canRetry = status.retryable && cooldownRemainingMs === 0;
  const Icon = status.phase === "offline" ? WifiOff : status.phase === "unavailable" ? ShieldAlert : RefreshCw;

  return (
    <div className="fc-status-shell">
      <div className="fc-status-card">
        <FreecordMark small />
        <div className={`fc-status-icon ${status.phase}`}>
          <Icon aria-hidden="true" />
        </div>
        <h1 className="fc-status-title">{copy.title}</h1>
        <p className="fc-status-detail">{copy.detail}</p>
        <p className="fc-status-hint">{copy.hint}</p>
        <div className="fc-status-actions">
          <button
            type="button"
            className="fc-status-retry"
            onClick={retry}
            disabled={!canRetry}
            aria-disabled={!canRetry}
          >
            <RefreshCw aria-hidden="true" />
            {waitSeconds > 0 ? `Try again in ${waitSeconds}s` : "Try again"}
          </button>
          {!copy.retryable && <span className="fc-status-note">Retrying from this tab can’t clear this one.</span>}
          {status.kind === "auth-session" && (
            // Session problems are recovered through the app's existing secure
            // sign-in flow — never by bypassing authentication.
            <a
              className="fc-status-secondary"
              href={`/auth?returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`}
            >
              Sign in again
            </a>
          )}
        </div>
        <DiagnosticsDetails />
      </div>
      {children}
    </div>
  );
}

/** Records uncaught errors into the in-memory diagnostic report (no network). */
export function DiagnosticsWatcher() {
  useEffect(() => installGlobalDiagnostics(), []);
  return null;
}

/** One connection notice for every route (the dashboard included). */
export function GlobalConnectionBanner() {
  const { status } = useServiceStatus();
  return <ConnectionBanner status={status} />;
}

/**
 * Non-blocking notice for states the app survives: reconnecting, offline, or a
 * soft connection error. It never covers the interface and never reloads.
 */
export function ConnectionBanner({ status }: { status: ServiceStatus }) {
  if (status.phase === "ready" || status.phase === "loading") return null;
  const message = PHASE_MESSAGES[status.phase];
  const tone = status.phase === "unavailable" ? "alert" : "notice";
  return (
    <div className={`fc-connection-banner ${tone}`} role="status" aria-live="polite">
      <span className="fc-connection-dot" aria-hidden="true" />
      <span>{message}</span>
      {status.copy?.retryable === false && <span className="fc-connection-banner-detail">See the message on screen for details.</span>}
    </div>
  );
}
