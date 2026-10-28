import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BrandSplash } from "@/components/ServiceStatus";
import { useAuth } from "@/hooks/use-auth";
import {
  readableSiteLockError,
  sanitizeRecoveryCodeInput,
  sanitizeSitePinInput,
  sitePasswordProblem,
  sitePinProblem,
  SITE_PASSWORD_MIN_LENGTH,
  SITE_PIN_MAX_DIGITS,
} from "@/lib/site-lock";
import useSiteAutoLock from "@/hooks/use-site-auto-lock";
import { PAGE_ID } from "@/lib/page-session";
import { useAction, useQuery } from "convex/react";
import { AudioLines, ArrowLeft, Eye, EyeOff, KeyRound, Loader2, Lock, Mail, Unlock } from "lucide-react";
import { useState, type ReactNode } from "react";

/**
 * The optional site lock screen.
 *
 * WHAT IT DOES
 * ------------
 * Freecord can be opened behind a PIN and/or an extra password that a member
 * chose to set up. This gate asks for exactly the credentials that are ENABLED —
 * and for nothing at all when none of them are:
 *
 *   - neither lock on → `status.enabled` is false and the app renders straight
 *     through, byte-for-byte the normal website (no screen, no prompt, no setup
 *     invite),
 *   - PIN only → the PIN field, password only → the password field, both → both
 *     fields are required in one submit,
 *   - a factor already verified for this session is not asked again until the
 *     member's auto-lock says so; the DEFAULT is "every page load", so a full
 *     refresh, closing and reopening Freecord, a new tab or a new sign-in asks
 *     again, while navigating between views inside the app does not. The proof is
 *     scoped to this page load (`PAGE_ID`), not kept in browser storage.
 *
 * The decision is read from the server (`api.siteLock.status`) on every render,
 * so it survives a full page reload and cannot be skipped by deep-linking into a
 * protected route: the dashboard is not even mounted until the response says the
 * session is satisfied, and verification itself only happens in a server action.
 *
 * The other half of that decision is the member's own auto-lock window: a device
 * left unused is locked again by `useSiteAutoLock`, and a proof past its window is
 * treated as unverified by the server itself, so reloading the page cannot stretch
 * the window the member chose.
 *
 * Recovery is on this screen too (the one place a locked-out member can reach):
 * an emailed single-use code, or the account password, can set a new credential
 * or turn that lock off — so a forgotten PIN or password is never a dead end.
 */
export default function SiteLockGate({ children }: { children: ReactNode }) {
  // The page-load id is what makes the default mode ask again after a refresh:
  // a proof claimed by a previous page load does not count for this one.
  const status = useQuery(api.siteLock.status, { pageId: PAGE_ID });
  // Locks the site again after the member's chosen window without activity
  // (Settings → Account → Login & Security). Inert while locked or when the
  // window is set to Never.
  useSiteAutoLock(status);

  // Still resolving: the branded splash, never a blank page.
  if (status === undefined) return <BrandSplash label="Checking your security locks…" />;

  // No lock enabled, or this session is already verified: the normal website.
  if (!status.enabled || status.unlocked) return <>{children}</>;

  return <LockScreen status={status} />;
}

/**
 * The verification screen. `status` is the same reactive query the gate uses, so
 * a successful verification flips the gate and this screen unmounts by itself.
 */
function LockScreen({
  status,
}: {
  status: {
    pinEnabled: boolean;
    passwordEnabled: boolean;
    pending: readonly ("pin" | "password")[];
    accountHasPassword: boolean;
    hasEmail: boolean;
    displayName: string;
    lockoutSeconds: number;
  };
}) {
  const verify = useAction(api.siteLock.verify);
  const requestRecoveryCode = useAction(api.siteLock.requestRecoveryCode);
  const recoverWithCode = useAction(api.siteLock.recoverWithCode);
  const disablePin = useAction(api.siteLock.disablePin);
  const disablePassword = useAction(api.siteLock.disablePassword);
  const { signOut } = useAuth();

  const needsPin = status.pending.includes("pin");
  const needsPassword = status.pending.includes("password");
  const both = needsPin && needsPassword;

  const [view, setView] = useState<"unlock" | "recover">("unlock");
  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // ---- recovery state ----
  const [target, setTarget] = useState<"pin" | "password">(status.pinEnabled ? "pin" : "password");
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [turnOff, setTurnOff] = useState(false);
  const [accountPassword, setAccountPassword] = useState("");

  const pinRuleOk = sitePinProblem(pin) === null;
  const passwordRuleOk = sitePasswordProblem(password) === null;
  const canSubmit =
    !busy && (!needsPin || pinRuleOk) && (!needsPassword || passwordRuleOk);

  const newPinOk = sitePinProblem(newPin) === null && newPin === confirmPin;
  const newPasswordOk = sitePasswordProblem(newPassword) === null && newPassword === confirmPassword;
  const canRecover =
    !busy &&
    code.length === 6 &&
    (turnOff || (target === "pin" ? newPinOk : newPasswordOk));

  function clearFields() {
    setPin("");
    setPassword("");
    setShowPassword(false);
    setError(null);
    setNotice(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await verify({
        ...(needsPin ? { pin } : {}),
        ...(needsPassword ? { password } : {}),
        pageId: PAGE_ID,
      });
      // The reactive status query flips the gate; nothing to navigate to.
    } catch (err) {
      setError(readableSiteLockError(err, "That PIN or password is not correct."));
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  async function sendCode() {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await requestRecoveryCode({});
      setCodeSentTo(result.email);
      setCode("");
      setTurnOff(false);
      setNotice(
        `We emailed a 6-digit code to ${result.email}. It expires in ${result.expiresInMinutes} minutes.`,
      );
    } catch (err) {
      setError(readableSiteLockError(err, "We couldn't send a recovery code."));
    } finally {
      setBusy(false);
    }
  }

  async function submitRecovery(e: React.FormEvent) {
    e.preventDefault();
    if (!canRecover) return;
    setError(null);
    setBusy(true);
    try {
      await recoverWithCode({
        code,
        target,
        disable: turnOff,
        pageId: PAGE_ID,
        ...(target === "pin" && !turnOff ? { newPin, confirmPin } : {}),
        ...(target === "password" && !turnOff ? { newPassword, confirmPassword } : {}),
      });
      setCode("");
      setNewPin("");
      setConfirmPin("");
      setNewPassword("");
      setConfirmPassword("");
      setNotice(
        turnOff
          ? `Your ${target === "pin" ? "PIN" : "password"} lock is off.`
          : `Your new ${target === "pin" ? "PIN" : "password"} is set.`,
      );
      setView("unlock");
    } catch (err) {
      setError(readableSiteLockError(err, "That recovery code is not correct."));
    } finally {
      setBusy(false);
    }
  }

  /**
   * The other recovery route: prove identity with the account's own Freecord
   * password and turn the locked-out credential off. Available to every account
   * that has one (accounts created with an email code do not, and they use the
   * emailed code instead).
   */
  async function recoverWithAccountPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!accountPassword || busy) return;
    setError(null);
    setBusy(true);
    try {
      if (target === "pin") await disablePin({ accountPassword });
      else await disablePassword({ accountPassword });
      setAccountPassword("");
      setNotice(`Your ${target === "pin" ? "PIN" : "password"} lock is off — continuing.`);
      setView("unlock");
    } catch (err) {
      setError(readableSiteLockError(err, "That account password is not correct."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fc-sitegate-shell" role="dialog" aria-label="Freecord is locked">
      <div className="fc-sitegate-card">
        <div className="fc-sitegate-mark">
          <AudioLines strokeWidth={2.7} aria-hidden="true" />
          <span>
            freecord<span className="brand-period">.</span>
          </span>
        </div>

        {view === "unlock" ? (
          <form className="fc-sitegate-body" onSubmit={submit}>
            <h1 className="fc-sitegate-title">
              <Lock size={18} aria-hidden="true" /> Freecord is locked
            </h1>
            <p className="fc-sitegate-sub">
              {status.displayName ? `${status.displayName}, ` : ""}
              {both
                ? "your PIN and your password are required to continue."
                : needsPin
                  ? "your PIN is required to continue."
                  : "your password is required to continue."}
            </p>

            {needsPin && (
              <label className="fc-sitegate-field">
                PIN (1–{SITE_PIN_MAX_DIGITS} digits)
                <div className="fc-pw-input">
                  <Input
                    value={pin}
                    onChange={(e) => setPin(sanitizeSitePinInput(e.target.value))}
                    inputMode="numeric"
                    autoComplete="off"
                    autoFocus
                    aria-label="PIN"
                    placeholder={"\u2022".repeat(4)}
                    maxLength={SITE_PIN_MAX_DIGITS}
                    disabled={busy}
                  />
                </div>
              </label>
            )}

            {needsPassword && (
              <label className="fc-sitegate-field">
                Password
                <div className="fc-pw-input">
                  <Input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    aria-label="Password"
                    placeholder="Your Freecord lock password"
                    disabled={busy}
                    autoFocus={!needsPin}
                  />
                  <button
                    type="button"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    onClick={() => setShowPassword((v) => !v)}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </label>
            )}

            {error && <p className="fc-sitegate-error" role="alert">{error}</p>}
            {notice && <p className="fc-sitegate-notice" role="status">{notice}</p>}
            {status.lockoutSeconds > 0 && !error && (
              <p className="fc-sitegate-error" role="alert">
                Too many incorrect attempts. Try again in {status.lockoutSeconds}s.
              </p>
            )}

            <div className="fc-sitegate-actions">
              <Button type="submit" disabled={!canSubmit}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Unlock className="mr-2 h-4 w-4" />}
                Unlock
              </Button>
              <Button type="button" variant="outline" onClick={clearFields} disabled={busy}>
                Clear
              </Button>
              <Button type="button" variant="ghost" onClick={() => { setError(null); setNotice(null); setView("recover"); }} disabled={busy}>
                Forgot {both ? "PIN or password" : needsPin ? "PIN" : "password"}?
              </Button>
            </div>

            <p className="fc-sitegate-foot">
              <span>This is an extra lock you set up. Your account sign-in is unchanged.</span>
              <button type="button" onClick={async () => { await signOut(); }} disabled={busy}>
                Not you? Sign out
              </button>
            </p>
          </form>
        ) : (
          <div className="fc-sitegate-body">
            <h1 className="fc-sitegate-title">
              <KeyRound size={18} aria-hidden="true" /> Recover your lock
            </h1>
            <p className="fc-sitegate-sub">
              Prove it&apos;s you with a code emailed to your account, or with your account password.
              Neither lock is required to use Freecord — if you turn it off, the site opens normally.
            </p>

            {status.pinEnabled && status.passwordEnabled && (
              <div className="fc-sitegate-chips" role="group" aria-label="Which lock">
                {(["pin", "password"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={`fc-sitegate-chip ${target === option ? "active" : ""}`}
                    aria-pressed={target === option}
                    onClick={() => { setTarget(option); setError(null); setNotice(null); }}
                  >
                    {option === "pin" ? "PIN lock" : "Password lock"}
                  </button>
                ))}
              </div>
            )}

            <form className="fc-sitegate-recover" onSubmit={submitRecovery}>
              <div className="fc-sitegate-actions">
                <Button type="button" variant="outline" onClick={sendCode} disabled={busy || !status.hasEmail}>
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Mail className="mr-2 h-4 w-4" />}
                  {codeSentTo ? "Email a new code" : "Email me a code"}
                </Button>
              </div>
              {!status.hasEmail && (
                <p className="fc-muted">
                  Your account has no email address, so use your account password below instead.
                </p>
              )}

              <label className="fc-sitegate-field">
                Recovery code
                <Input
                  value={code}
                  onChange={(e) => setCode(sanitizeRecoveryCodeInput(e.target.value))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  aria-label="Recovery code"
                  placeholder={"0".repeat(6)}
                  disabled={busy || !codeSentTo}
                />
              </label>

              <label className="fc-toggle-row">
                <span>
                  <strong>Turn this lock off instead</strong>
                  <small>Freecord will open normally until you enable it again.</small>
                </span>
                <input type="checkbox" className="fc-switch" checked={turnOff} onChange={(e) => setTurnOff(e.target.checked)} disabled={busy} />
              </label>

              {!turnOff && target === "pin" && (
                <>
                  <label className="fc-sitegate-field">
                    New PIN (1–{SITE_PIN_MAX_DIGITS} digits)
                    <Input
                      value={newPin}
                      onChange={(e) => setNewPin(sanitizeSitePinInput(e.target.value))}
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={SITE_PIN_MAX_DIGITS}
                      aria-label="New PIN"
                      disabled={busy}
                    />
                  </label>
                  <label className="fc-sitegate-field">
                    Confirm new PIN
                    <Input
                      value={confirmPin}
                      onChange={(e) => setConfirmPin(sanitizeSitePinInput(e.target.value))}
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={SITE_PIN_MAX_DIGITS}
                      aria-label="Confirm new PIN"
                      disabled={busy}
                    />
                  </label>
                  {confirmPin.length > 0 && newPin !== confirmPin && (
                    <p className="fc-sitegate-error">Those PINs don&apos;t match.</p>
                  )}
                </>
              )}

              {!turnOff && target === "password" && (
                <>
                  <label className="fc-sitegate-field">
                    New password
                    <Input
                      type={showPassword ? "text" : "password"}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      autoComplete="new-password"
                      aria-label="New password"
                      disabled={busy}
                    />
                  </label>
                  <label className="fc-sitegate-field">
                    Confirm new password
                    <Input
                      type={showPassword ? "text" : "password"}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      autoComplete="new-password"
                      aria-label="Confirm new password"
                      disabled={busy}
                    />
                  </label>
                  <p className="fc-muted">
                    At least {SITE_PASSWORD_MIN_LENGTH} characters, with one letter and one number.
                    Symbols and spaces are welcome.
                  </p>
                  {confirmPassword.length > 0 && newPassword !== confirmPassword && (
                    <p className="fc-sitegate-error">Those passwords don&apos;t match.</p>
                  )}
                </>
              )}

              <div className="fc-sitegate-actions">
                <Button type="submit" disabled={!canRecover}>
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
                  {turnOff ? "Turn the lock off" : "Set the new credential"}
                </Button>
              </div>
            </form>

            {status.accountHasPassword && (
              <form className="fc-sitegate-recover" onSubmit={recoverWithAccountPassword}>
                <p className="fc-muted">
                  Or confirm with your Freecord account password (the one you sign in with) to turn the{" "}
                  {target === "pin" ? "PIN" : "password"} lock off.
                </p>
                <label className="fc-sitegate-field">
                  Account password
                  <Input
                    type="password"
                    value={accountPassword}
                    onChange={(e) => setAccountPassword(e.target.value)}
                    autoComplete="current-password"
                    aria-label="Account password"
                    disabled={busy}
                  />
                </label>
                <div className="fc-sitegate-actions">
                  <Button type="submit" variant="outline" disabled={busy || !accountPassword}>
                    Turn off with account password
                  </Button>
                </div>
              </form>
            )}

            {error && <p className="fc-sitegate-error" role="alert">{error}</p>}
            {notice && <p className="fc-sitegate-notice" role="status">{notice}</p>}

            <div className="fc-sitegate-actions">
              <Button type="button" variant="ghost" onClick={() => { setError(null); setNotice(null); setView("unlock"); }}>
                <ArrowLeft className="mr-2 h-4 w-4" /> Back to unlock
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
