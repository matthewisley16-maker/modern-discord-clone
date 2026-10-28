import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  readableSiteLockError,
  sanitizeSitePinInput,
  SITE_AUTO_LOCK_CHOICES,
  SITE_AUTO_LOCK_NEVER,
  siteAutoLockLabel,
  siteAutoLockMinutes,
  sitePasswordProblem,
  sitePinProblem,
  SITE_PASSWORD_MIN_LENGTH,
  SITE_PIN_MAX_DIGITS,
} from "@/lib/site-lock";
import { useAction, useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { Clock, Eye, EyeOff, KeyRound, Loader2, Lock, ShieldCheck } from "lucide-react";

/**
 * Settings → Account → Login & Security.
 *
 * Two INDEPENDENT, OPTIONAL locks on top of the normal Freecord sign-in:
 * a 1–10 digit PIN (leading zeros kept) and an extra password. Turning either on
 * or off never touches the other, never touches account authentication, and never
 * signs anybody out. With both off — the default for every account — Freecord
 * opens exactly as it did before this section existed, and nothing here is ever
 * required or prompted for.
 *
 * Everything is verified server-side (see `src/convex/siteLock.ts`): these forms
 * only collect input and show the server's own error messages. Changing or turning
 * a lock off requires proof of identity — the current credential, or the account's
 * Freecord password — so a forgotten PIN/password is not a lockout. A member who
 * cannot reach settings at all can recover from the lock screen with an emailed
 * code instead.
 *
 * The AUTO-LOCK card decides how long a device may sit unused before the enabled
 * credentials are asked for again. It is a preference (it can never turn a lock
 * off or unlock anything), the server stores it on the member's own lock row, and
 * "Never" keeps the original behaviour of staying satisfied until sign-out.
 */
export default function SiteLockSettings() {
  const status = useQuery(api.siteLock.status, {});
  const setPin = useAction(api.siteLock.setPin);
  const setPassword = useAction(api.siteLock.setPassword);
  const disablePin = useAction(api.siteLock.disablePin);
  const disablePassword = useAction(api.siteLock.disablePassword);
  const lockNow = useMutation(api.siteLock.lockNow);
  const setAutoLock = useMutation(api.siteLock.setAutoLock);
  const [autoLockBusy, setAutoLockBusy] = useState(false);

  const [pinMode, setPinMode] = useState<null | "set" | "change" | "disable">(null);
  const [pinCurrent, setPinCurrent] = useState("");
  const [pinNew, setPinNew] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [pinProof, setPinProof] = useState<"pin" | "account">("pin");
  const [pinDisableValue, setPinDisableValue] = useState("");

  const [pwMode, setPwMode] = useState<null | "set" | "change" | "disable">(null);
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwProof, setPwProof] = useState<"password" | "account">("password");
  const [pwDisableValue, setPwDisableValue] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  if (status === undefined) {
    return (
      <section className="fc-settings-section">
        <h3><ShieldCheck size={16} /> Login &amp; Security</h3>
        <p className="fc-muted">Checking your optional PIN and password locks…</p>
      </section>
    );
  }

  // What the enabled credentials are called in the auto-lock copy.
  const guardLabel =
    status.pinEnabled && status.passwordEnabled ? "PIN or password" : status.pinEnabled ? "PIN" : "password";
  const autoLockMinutes = siteAutoLockMinutes(status.autoLockMinutes);

  function resetPinForm() {
    setPinCurrent("");
    setPinNew("");
    setPinConfirm("");
    setPinDisableValue("");
    setPinProof("pin");
    setPinMode(null);
  }

  function resetPwForm() {
    setPwCurrent("");
    setPwNew("");
    setPwConfirm("");
    setPwDisableValue("");
    setPwProof("password");
    setPwMode(null);
  }

  function fail(err: unknown, fallback: string) {
    toast.error(readableSiteLockError(err, fallback));
  }

  /**
   * Can the "turn the PIN lock off" form be submitted? The chosen proof has to be
   * present — except for an account with no password credential (email-code
   * sign-in): there the signed-in session is the proof, so a forgotten PIN is
   * never a dead end and the field may be left empty.
   */
  const pinDisableReady =
    pinProof === "account"
      ? pinDisableValue.length > 0
      : status.accountHasPassword
        ? sitePinProblem(pinDisableValue) === null
        : true;
  const pinNewOk = sitePinProblem(pinNew) === null && pinNew === pinConfirm;
  const pinCanSubmit =
    !busy &&
    (pinMode === "set" ? pinNewOk : pinMode === "change" ? pinNewOk && pinCurrent.length > 0 : pinDisableReady);

  async function submitPin(e: React.FormEvent) {
    e.preventDefault();
    if (!pinCanSubmit || pinMode === null) return;
    setBusy(true);
    try {
      if (pinMode === "set" || pinMode === "change") {
        await setPin({
          pin: pinNew,
          confirmPin: pinConfirm,
          ...(pinMode === "change" ? { currentPin: pinCurrent } : {}),
        });
        toast.success(pinMode === "change" ? "PIN updated." : "PIN lock is on.");
      } else {
        await disablePin(pinProof === "account" ? { accountPassword: pinDisableValue } : { pin: pinDisableValue });
        toast.success("PIN lock is off. Freecord opens normally without it.");
      }
      resetPinForm();
    } catch (err) {
      fail(err, "Could not update your PIN lock.");
    } finally {
      setBusy(false);
    }
  }

  /** The same identity-proof rule for the password lock. */
  const pwDisableReady =
    pwProof === "account"
      ? pwDisableValue.length > 0
      : status.accountHasPassword
        ? pwDisableValue.length > 0
        : true;
  const pwNewOk = sitePasswordProblem(pwNew) === null && pwNew === pwConfirm;
  const pwCanSubmit =
    !busy &&
    (pwMode === "set" ? pwNewOk : pwMode === "change" ? pwNewOk && pwCurrent.length > 0 : pwDisableReady);

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!pwCanSubmit || pwMode === null) return;
    setBusy(true);
    try {
      if (pwMode === "set" || pwMode === "change") {
        await setPassword({
          password: pwNew,
          confirmPassword: pwConfirm,
          ...(pwMode === "change" ? { currentPassword: pwCurrent } : {}),
        });
        toast.success(pwMode === "change" ? "Lock password updated." : "Password lock is on.");
      } else {
        await disablePassword(
          pwProof === "account" ? { accountPassword: pwDisableValue } : { password: pwDisableValue },
        );
        toast.success("Password lock is off. Freecord opens normally without it.");
      }
      resetPwForm();
    } catch (err) {
      fail(err, "Could not update your password lock.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="fc-settings-section">
      <h3><ShieldCheck size={16} /> Login &amp; Security</h3>
      <p className="fc-muted">
        Optional extra locks for Freecord itself. Both are off by default and neither is ever
        required — PIN only, password only, both, or neither all work. Turning them off restores the
        normal sign-in flow, and none of this changes your account password or signs you out.
      </p>

      {/* ------------------------------- PIN lock ------------------------------- */}
      <div className="fc-lock-card">
        <div className="fc-lock-head">
          <div>
            <p className="fc-lock-title">
              <KeyRound size={15} aria-hidden="true" /> PIN lock
              <span className={`fc-badge ${status.pinEnabled ? "pin" : ""}`}>{status.pinEnabled ? "ON" : "OFF"}</span>
            </p>
            <p className="fc-muted">
              A numeric PIN of 1–{SITE_PIN_MAX_DIGITS} digits, asked when a new session starts.
              Leading zeros are kept, so 0042 stays 0042.
            </p>
          </div>
        </div>

        {pinMode === null && (
          <div className="fc-lock-actions">
            {status.pinEnabled ? (
              <>
                <Button variant="outline" onClick={() => setPinMode("change")}>
                  <KeyRound size={14} /> Change PIN
                </Button>
                <Button variant="ghost" onClick={() => setPinMode("disable")}>Turn off</Button>
              </>
            ) : (
              <Button onClick={() => setPinMode("set")}>
                <Lock size={14} /> Enable PIN lock
              </Button>
            )}
          </div>
        )}

        {pinMode !== null && (
          <form className="fc-pw-form" onSubmit={submitPin}>
            {pinMode === "change" && (
              <label>
                Current PIN
                <Input
                  value={pinCurrent}
                  onChange={(e) => setPinCurrent(sanitizeSitePinInput(e.target.value))}
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={SITE_PIN_MAX_DIGITS}
                  aria-label="Current PIN"
                  disabled={busy}
                />
              </label>
            )}

            {(pinMode === "set" || pinMode === "change") && (
              <>
                <label>
                  New PIN
                  <Input
                    value={pinNew}
                    onChange={(e) => setPinNew(sanitizeSitePinInput(e.target.value))}
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={SITE_PIN_MAX_DIGITS}
                    aria-label="New PIN"
                    disabled={busy}
                  />
                </label>
                <label>
                  Confirm new PIN
                  <Input
                    value={pinConfirm}
                    onChange={(e) => setPinConfirm(sanitizeSitePinInput(e.target.value))}
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={SITE_PIN_MAX_DIGITS}
                    aria-label="Confirm new PIN"
                    disabled={busy}
                  />
                </label>
                <p className="fc-muted">
                  1–{SITE_PIN_MAX_DIGITS} digits, digits only. Leading zeros are preserved.
                </p>
                {pinConfirm.length > 0 && pinNew !== pinConfirm && (
                  <p className="text-xs text-destructive">Those PINs don&apos;t match.</p>
                )}
              </>
            )}

            {pinMode === "disable" && (
              <>
                <p className="fc-muted">
                  Confirm it&apos;s you before turning the PIN lock off.
                  {!status.accountHasPassword && " Your account has no password credential, so your signed-in session is the proof."}
                </p>
                {status.accountHasPassword && (
                  <div className="fc-radio-row">
                    <label className={`fc-radio ${pinProof === "pin" ? "active" : ""}`}>
                      <input type="radio" name="pin-proof" checked={pinProof === "pin"} onChange={() => setPinProof("pin")} />
                      Current PIN
                    </label>
                    <label className={`fc-radio ${pinProof === "account" ? "active" : ""}`}>
                      <input type="radio" name="pin-proof" checked={pinProof === "account"} onChange={() => setPinProof("account")} />
                      Account password
                    </label>
                  </div>
                )}
                {pinProof === "pin" ? (
                  <label>
                    Current PIN
                    <Input
                      value={pinDisableValue}
                      onChange={(e) => setPinDisableValue(sanitizeSitePinInput(e.target.value))}
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={SITE_PIN_MAX_DIGITS}
                      aria-label="Current PIN"
                      disabled={busy}
                    />
                  </label>
                ) : (
                  <label>
                    Account password
                    <Input
                      type="password"
                      value={pinDisableValue}
                      onChange={(e) => setPinDisableValue(e.target.value)}
                      autoComplete="current-password"
                      aria-label="Account password"
                      disabled={busy}
                    />
                  </label>
                )}
              </>
            )}

            <div className="fc-pw-actions">
              <Button type="submit" disabled={!pinCanSubmit}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {pinMode === "set" ? "Turn PIN lock on" : pinMode === "change" ? "Update PIN" : "Turn PIN lock off"}
              </Button>
              <Button type="button" variant="ghost" onClick={resetPinForm} disabled={busy}>Cancel</Button>
            </div>
          </form>
        )}
      </div>

      {/* ----------------------------- Password lock ----------------------------- */}
      <div className="fc-lock-card">
        <div className="fc-lock-head">
          <div>
            <p className="fc-lock-title">
              <Lock size={15} aria-hidden="true" /> Password lock
              <span className={`fc-badge ${status.passwordEnabled ? "pin" : ""}`}>{status.passwordEnabled ? "ON" : "OFF"}</span>
            </p>
            <p className="fc-muted">
              An extra password of your own, separate from your account password — at least{" "}
              {SITE_PASSWORD_MIN_LENGTH} characters with one letter and one number. Symbols, spaces
              and capital letters are all fine.
            </p>
          </div>
        </div>

        {pwMode === null && (
          <div className="fc-lock-actions">
            {status.passwordEnabled ? (
              <>
                <Button variant="outline" onClick={() => setPwMode("change")}>
                  <KeyRound size={14} /> Change password
                </Button>
                <Button variant="ghost" onClick={() => setPwMode("disable")}>Turn off</Button>
              </>
            ) : (
              <Button onClick={() => setPwMode("set")}>
                <Lock size={14} /> Enable Password lock
              </Button>
            )}
          </div>
        )}

        {pwMode !== null && (
          <form className="fc-pw-form" onSubmit={submitPassword}>
            {pwMode === "change" && (
              <label>
                Current lock password
                <div className="fc-pw-input">
                  <Input
                    type={show ? "text" : "password"}
                    value={pwCurrent}
                    autoComplete="current-password"
                    onChange={(e) => setPwCurrent(e.target.value)}
                    disabled={busy}
                    aria-label="Current lock password"
                  />
                  <button type="button" aria-label={show ? "Hide passwords" : "Show passwords"} onClick={() => setShow((v) => !v)}>
                    {show ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </label>
            )}

            {(pwMode === "set" || pwMode === "change") && (
              <>
                <label>
                  New lock password
                  <div className="fc-pw-input">
                    <Input
                      type={show ? "text" : "password"}
                      value={pwNew}
                      autoComplete="new-password"
                      onChange={(e) => setPwNew(e.target.value)}
                      disabled={busy}
                      aria-label="New lock password"
                    />
                    <button type="button" aria-label={show ? "Hide passwords" : "Show passwords"} onClick={() => setShow((v) => !v)}>
                      {show ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </label>
                <label>
                  Confirm new lock password
                  <Input
                    type={show ? "text" : "password"}
                    value={pwConfirm}
                    autoComplete="new-password"
                    onChange={(e) => setPwConfirm(e.target.value)}
                    disabled={busy}
                    aria-label="Confirm new lock password"
                  />
                </label>
                <p className="fc-muted">
                  At least {SITE_PASSWORD_MIN_LENGTH} characters, with one letter and one number.
                </p>
                {pwConfirm.length > 0 && pwNew !== pwConfirm && (
                  <p className="text-xs text-destructive">Those passwords don&apos;t match.</p>
                )}
              </>
            )}

            {pwMode === "disable" && (
              <>
                <p className="fc-muted">
                  Confirm it&apos;s you before turning the password lock off.
                  {!status.accountHasPassword && " Your account has no password credential, so your signed-in session is the proof."}
                </p>
                {status.accountHasPassword && (
                  <div className="fc-radio-row">
                    <label className={`fc-radio ${pwProof === "password" ? "active" : ""}`}>
                      <input type="radio" name="pw-proof" checked={pwProof === "password"} onChange={() => setPwProof("password")} />
                      Current lock password
                    </label>
                    <label className={`fc-radio ${pwProof === "account" ? "active" : ""}`}>
                      <input type="radio" name="pw-proof" checked={pwProof === "account"} onChange={() => setPwProof("account")} />
                      Account password
                    </label>
                  </div>
                )}
                <label>
                  {pwProof === "password" ? "Current lock password" : "Account password"}
                  <Input
                    type="password"
                    value={pwDisableValue}
                    autoComplete="current-password"
                    onChange={(e) => setPwDisableValue(e.target.value)}
                    disabled={busy}
                    aria-label={pwProof === "password" ? "Current lock password" : "Account password"}
                  />
                </label>
              </>
            )}

            <div className="fc-pw-actions">
              <Button type="submit" disabled={!pwCanSubmit}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {pwMode === "set"
                  ? "Turn password lock on"
                  : pwMode === "change"
                    ? "Update password"
                    : "Turn password lock off"}
              </Button>
              <Button type="button" variant="ghost" onClick={resetPwForm} disabled={busy}>Cancel</Button>
            </div>
          </form>
        )}
      </div>

      {/* ------------------------------ Auto-lock ------------------------------ */}
      {(status.pinEnabled || status.passwordEnabled) && (
        <div className="fc-lock-card">
          <div className="fc-lock-head">
            <div>
              <p className="fc-lock-title">
                <Clock size={15} aria-hidden="true" /> Auto-lock
              </p>
              <p className="fc-muted">
                How long this device may sit unused before Freecord asks for your {guardLabel} again.
                The countdown restarts with every click, keypress, tap or call, and each device counts
                on its own — locking one never locks another.
              </p>
            </div>
          </div>
          <label className="fc-select-row">Lock after
            <select
              className="fc-select"
              aria-label="Auto-lock delay"
              value={String(autoLockMinutes)}
              disabled={autoLockBusy}
              onChange={async (e) => {
                const next = Number(e.target.value);
                setAutoLockBusy(true);
                try {
                  await setAutoLock({ minutes: next });
                  toast.success(
                    next === SITE_AUTO_LOCK_NEVER
                      ? "Auto-lock is off — Freecord stays unlocked until you sign out."
                      : `Freecord will ask for your ${guardLabel} again after ${siteAutoLockLabel(next)} without activity.`,
                  );
                } catch (err) {
                  fail(err, "Could not save the auto-lock delay.");
                } finally {
                  setAutoLockBusy(false);
                }
              }}
            >
              {SITE_AUTO_LOCK_CHOICES.map((choice) => (
                <option key={choice} value={choice}>{siteAutoLockLabel(choice)}</option>
              ))}
            </select>
          </label>
          <p className="fc-muted">
            {autoLockMinutes === SITE_AUTO_LOCK_NEVER
              ? "Turned off — an unlocked device stays open until you sign out, until that session ends, or until you press Lock Freecord now."
              : `This device currently locks itself after ${siteAutoLockLabel(autoLockMinutes)} without activity. Lock Freecord now still locks it immediately.`}
          </p>
        </div>
      )}

      {(status.pinEnabled || status.passwordEnabled) && (
        <div className="fc-note">
          <p>
            <strong>You&apos;re covered if you forget one.</strong> From the lock screen, use{" "}
            <em>Forgot PIN/password</em> to get a single-use code by email
            {status.hasEmail ? "" : " (add an email in this tab to enable that)"}, or confirm with your
            account password here in Settings. A forgotten PIN or password never locks you out of your
            own account.
          </p>
          <p className="fc-muted">
            Sessions: a lock is asked once when a session starts and stays satisfied while that device
            is being used{autoLockMinutes === SITE_AUTO_LOCK_NEVER
              ? ", right up until you sign out (auto-lock is off)"
              : `, until ${siteAutoLockLabel(autoLockMinutes)} pass without activity`}. Refreshing the
            page never re-prompts on its own, and a device past its window is asked again — the server
            checks that, not the browser.
          </p>
        </div>
      )}

      {(status.pinEnabled || status.passwordEnabled) && (
        <div className="fc-lock-actions">
          <Button
            variant="outline"
            disabled={busy}
            onClick={async () => {
              try {
                await lockNow({});
                toast.success("Locked. The unlock screen is showing.");
              } catch (err) {
                fail(err, "Could not lock Freecord.");
              }
            }}
          >
            <Lock size={14} /> Lock Freecord now
          </Button>
          <span className="fc-muted">Test it immediately — you&apos;ll be asked for your enabled credentials.</span>
        </div>
      )}

      {!status.pinEnabled && !status.passwordEnabled && (
        <p className="fc-muted">
          Both locks are off, so Freecord opens with your normal sign-in only — exactly as before.
        </p>
      )}
    </section>
  );
}
