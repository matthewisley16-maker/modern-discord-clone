import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { callActive, onCallActiveChange } from "@/lib/call-activity";
import {
  SITE_AUTO_LOCK_DEFAULT_MINUTES,
  siteAutoLockMinutes,
  siteAutoLockMode,
  siteAutoLockReportIntervalMs,
  siteAutoLockWindowMs,
} from "@/lib/site-lock";

/**
 * The idle half of the optional site lock.
 *
 * WHAT IT DOES
 * ------------
 * While a lock is ON, this device is unlocked and the member chose a TIMER, this
 * monitor watches real user activity and, once that window passes without any of
 * it, locks Freecord again (the same `lockNow` the settings screen offers, which
 * revokes THIS device's proofs only).
 *
 * The other two modes need nothing here: "every page load" (the default) is
 * enforced by the proof being scoped to the page load, and "never until sign-out"
 * has nothing to count down.
 *
 * The countdown is the SERVER's own deadline, not a client invention:
 * `status.autoLockExpiresAt` is computed from this account's proof rows, so a
 * refresh, a second tab or another device can never extend it behind the server's
 * back — and the gate itself re-locks whenever that deadline passes while the
 * proof is read. Activity is reported at most once per
 * `siteAutoLockReportIntervalMs`, which is a handful of small writes per hour of
 * use rather than one per keystroke.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * It never locks anybody else's device (the mutation is scoped to this session),
 * never asks for a credential itself, never writes anything to browser storage,
 * and never interrupts a live call: an open call is treated as use, so a
 * conversation is never dropped by the lock. With the window set to "Never" the
 * monitor schedules nothing at all.
 */
export type SiteAutoLockStatus = {
  enabled?: boolean;
  unlocked?: boolean;
  autoLockMinutes?: number;
  autoLockExpiresAt?: number | null;
};

/** Real user activity on this screen. Nothing synthetic is ever counted. */
const WINDOW_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"] as const;

export default function useSiteAutoLock(status: SiteAutoLockStatus | undefined | null) {
  const refresh = useMutation(api.siteLock.refreshAutoLock);
  const lockNow = useMutation(api.siteLock.lockNow);

  // Only an unlocked, enabled session on THIS device has anything to run.
  const armed = Boolean(status?.enabled) && Boolean(status?.unlocked);
  const autoLockMinutes = armed ? siteAutoLockMinutes(status?.autoLockMinutes) : SITE_AUTO_LOCK_DEFAULT_MINUTES;
  const serverDeadline =
    armed && typeof status?.autoLockExpiresAt === "number" ? status.autoLockExpiresAt : null;

  // A call on screen is use, even with no clicks at all.
  const [callOpen, setCallOpen] = useState(() => callActive());
  useEffect(() => onCallActiveChange(setCallOpen), []);

  // Starts at 0 and is stamped by the effects below (never during render).
  const live = useRef({ lastActivity: 0, reportedAt: 0 });
  const watching = armed && siteAutoLockMode(autoLockMinutes) === "idle";

  // ---------------------------------------------------------------------------
  // Report activity: keeps the window open while the member is actually here.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!watching) return;
    // Arming counts as being here, so the window starts now rather than at 0.
    live.current.lastActivity = Date.now();
    live.current.reportedAt = 0;
    const reportEvery = siteAutoLockReportIntervalMs(autoLockMinutes);
    const noteActivity = () => {
      const now = Date.now();
      live.current.lastActivity = now;
      if (now - live.current.reportedAt < reportEvery) return;
      live.current.reportedAt = now;
      // Best effort on purpose: if a report is dropped (a rate limit, a lost
      // connection) the proof simply is not extended, and the countdown below
      // locks this device as it would have anyway. Nothing is left half-done.
      void refresh({}).catch(() => {});
    };
    for (const event of WINDOW_EVENTS) window.addEventListener(event, noteActivity, { passive: true });
    document.addEventListener("visibilitychange", noteActivity);
    return () => {
      for (const event of WINDOW_EVENTS) window.removeEventListener(event, noteActivity);
      document.removeEventListener("visibilitychange", noteActivity);
    };
  }, [watching, autoLockMinutes, refresh]);

  // A call ending is the moment the countdown may start again from (and on mount
  // this is just the same "someone is here" stamp the activity effect writes).
  useEffect(() => {
    if (!callOpen) live.current.lastActivity = Date.now();
  }, [callOpen]);

  // ---------------------------------------------------------------------------
  // The countdown itself: at the deadline, lock this device through the server.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!watching) return;
    // No countdown during a call: it restarts when the call ends (above).
    if (callOpen) return;
    const windowMs = siteAutoLockWindowMs(autoLockMinutes);
    // The server's deadline is authoritative, while local activity guarantees a
    // report still in flight cannot lock the screen the member is using.
    const deadline = Math.max(serverDeadline ?? 0, live.current.lastActivity + windowMs);
    const timer = window.setTimeout(
      () => {
        // Revokes THIS device's proofs only, so the gate's own query shows the
        // unlock screen; a late browser timer can only lock an already-expired
        // session, never a fresh one and never anybody else's device.
        void lockNow({}).catch(() => {});
      },
      Math.max(0, deadline - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [watching, autoLockMinutes, serverDeadline, callOpen, lockNow]);
}
