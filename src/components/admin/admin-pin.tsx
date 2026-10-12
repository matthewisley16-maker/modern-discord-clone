import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useAction, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  ADMIN_PIN_MAX_DIGITS,
  ADMIN_PIN_MIN_DIGITS,
  adminPinLockoutSeconds,
  adminPinProblem,
  adminPinsMatch,
  sanitizeAdminPinInput,
} from "@/lib/admin-pin";
import { toast } from "sonner";
import { ArrowLeft, KeyRound, Lock, ShieldCheck, Unlock } from "lucide-react";

/**
 * OPTIONAL Admin PIN — the two pieces of UI.
 *
 * `AdminPinGate` is shown INSTEAD of the panel while PIN protection is on and
 * this session has not entered the PIN. `AdminPinSettings` lives in the panel's
 * Admin Settings tab, where an administrator can set a PIN up, change it, turn
 * protection off, or skip setup for good.
 *
 * The PIN rules (1–10 digits, leading zeros kept, match/validation messages) come
 * from the shared pure module, and every action re-checks the administrator role
 * on the server — this file decides what to SHOW, never what is allowed.
 */

type PinStatus = FunctionReturnType<typeof api.adminPin.status>;

/** A shared error line so failures are visible, not just toasted. */
function ErrorLine({ message }: { message: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-xs text-destructive">
      {message}
    </p>
  );
}

/** Reads a ConvexError's user-safe message. */
function friendly(err: unknown, fallback: string): string {
  const any = err as { data?: unknown; message?: string };
  if (typeof any?.data === "string" && any.data.trim()) return any.data;
  if (any?.data && typeof (any.data as { message?: string }).message === "string") {
    return (any.data as { message: string }).message;
  }
  if (typeof any?.message === "string" && any.message.trim()) {
    return any.message.replace(/^\[.*?\]\s*/, "").split("\n")[0].slice(0, 200);
  }
  return fallback;
}

/**
 * The lock screen. Nothing of the panel renders behind it: no admin query, no
 * tab — only the PIN prompt, an escape hatch, and a way back to Freecord.
 */
export function AdminPinGate({ status }: { status: PinStatus }) {
  const navigate = useNavigate();
  const unlock = useAction(api.adminPin.unlock);
  const turnOffPin = useAction(api.adminPin.disable);
  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Live countdown while a temporary lockout is in effect.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!status.lockedUntil || status.lockedUntil <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status.lockedUntil]);
  const lockout = adminPinLockoutSeconds(status.lockedUntil, now);

  const submitPin = async () => {
    setError("");
    const problem = adminPinProblem(pin);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      await unlock({ pin });
      setPin("");
      toast.success("Admin Panel unlocked.");
    } catch (err) {
      setError(friendly(err, "Could not unlock the Admin Panel."));
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setError("");
    setBusy(true);
    try {
      await turnOffPin(status.accountHasPassword && password ? { password } : {});
      setPassword("");
      toast.success("Admin PIN protection turned off — the panel uses your account and role again.");
    } catch (err) {
      setError(friendly(err, "Could not turn off PIN protection."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <Card className="w-full max-w-md border-white/10 bg-card/60">
        <CardHeader className="text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-amber-400/15">
            <Lock className="size-6 text-amber-300" />
          </div>
          <CardTitle>Admin Panel is locked</CardTitle>
          <CardDescription>
            You turned on the optional Admin PIN for this account. Enter it to open the protected admin pages.
            {status.unlockMinutes > 0 && ` A correct PIN keeps them open for ${status.unlockMinutes} minutes on this device.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="admin-pin-gate">
              Admin PIN
            </label>
            <div className="flex gap-2">
              <Input
                id="admin-pin-gate"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                autoFocus
                maxLength={status.maxDigits}
                placeholder={`${ADMIN_PIN_MIN_DIGITS}–${ADMIN_PIN_MAX_DIGITS} digits`}
                value={pin}
                onChange={(e) => setPin(sanitizeAdminPinInput(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitPin();
                }}
              />
              <Button disabled={busy || lockout > 0} onClick={submitPin}>
                <Unlock className="mr-1 size-4" /> Unlock
              </Button>
            </div>
            {lockout > 0 && (
              <p className="text-xs text-destructive">Too many attempts. Try again in {lockout}s.</p>
            )}
            <ErrorLine message={error} />
          </div>

          <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
            <p className="text-xs font-medium text-foreground">Forgot your PIN?</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {status.accountHasPassword
                ? "Confirm your identity with your Freecord account password to turn PIN protection off. Your account and administrator role are unaffected."
                : "Your account has no password (you sign in with a code or as a guest), so this signed-in administrator session is the identity check. Turning protection off does not change your account, your role, or any Freecord data."}
            </p>
            {status.accountHasPassword && (
              <Input
                className="mt-2"
                type="password"
                autoComplete="current-password"
                placeholder="Account password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              disabled={busy || (status.accountHasPassword && password.length === 0)}
              onClick={turnOff}
            >
              Turn off PIN protection
            </Button>
          </div>

          <div className="flex justify-center">
            <Button variant="ghost" size="sm" onClick={() => navigate("/dashboard")}>
              <ArrowLeft className="mr-2 size-4" /> Back to Freebuff
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}

/**
 * Admin Settings → "Admin PIN (optional)".
 *
 * Skipping is a first-class choice: it is remembered server-side (`skippedAt`),
 * the panel never asks again, and nothing about the administrator's access
 * changes — the account and role checks keep working exactly as before.
 */
export function AdminPinSettings({ status }: { status: PinStatus }) {
  const savePin = useAction(api.adminPin.setPin);
  const disablePin = useAction(api.adminPin.disable);
  const skip = useMutation(api.adminPin.skip);
  const lock = useMutation(api.adminPin.lock);

  const [mode, setMode] = useState<"idle" | "setup" | "change" | "disable">("idle");
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [currentPin, setCurrentPin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setPin("");
    setConfirmPin("");
    setCurrentPin("");
    setPassword("");
    setError("");
  };

  const run = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      reset();
      setMode("idle");
      toast.success(message);
    } catch (err) {
      setError(friendly(err, "That didn't work. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  const submitPin = () => {
    const problem = adminPinProblem(pin);
    if (problem) {
      setError(problem);
      return;
    }
    if (!adminPinsMatch(pin, confirmPin)) {
      setError("Those PINs don't match.");
      return;
    }
    void run(
      () => savePin({ pin, confirmPin, currentPin: mode === "change" ? currentPin : undefined }),
      mode === "change" ? "Admin PIN changed." : "Admin PIN enabled — the panel now asks for it.",
    );
  };

  const pinFields = (withCurrent: boolean) => (
    <div className="space-y-3">
      {withCurrent && (
        <div className="space-y-2">
          <label className="text-sm font-medium">Current PIN</label>
          <Input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={status.maxDigits}
            value={currentPin}
            onChange={(e) => setCurrentPin(sanitizeAdminPinInput(e.target.value))}
          />
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <label className="text-sm font-medium">Admin PIN</label>
          <Input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={status.maxDigits}
            placeholder={`${ADMIN_PIN_MIN_DIGITS}–${ADMIN_PIN_MAX_DIGITS} digits`}
            value={pin}
            onChange={(e) => setPin(sanitizeAdminPinInput(e.target.value))}
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">Confirm PIN</label>
          <Input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={status.maxDigits}
            value={confirmPin}
            onChange={(e) => setConfirmPin(sanitizeAdminPinInput(e.target.value))}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {ADMIN_PIN_MIN_DIGITS}–{ADMIN_PIN_MAX_DIGITS} digits, and leading zeros count — <span className="text-foreground">007</span>{" "}
        is a valid PIN and is different from <span className="text-foreground">7</span>.
      </p>
      <ErrorLine message={error} />
      <div className="flex gap-2">
        <Button disabled={busy} onClick={submitPin}>
          <KeyRound className="mr-1 size-4" /> {mode === "change" ? "Change PIN" : "Enable Admin PIN"}
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            reset();
            setMode("idle");
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );

  return (
    <Card className="border-white/10 bg-card/50">
      <CardHeader className="gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle className="text-base">Admin PIN (optional)</CardTitle>
          <CardDescription>
            Add a PIN in front of the Admin Panel. Entirely your choice, always separate from signing in to
            Freecord, and it never changes your account or role.
          </CardDescription>
        </div>
        {status.enabled ? (
          <Badge variant="outline" className="border-amber-400/40 text-amber-300">
            <Lock className="mr-1 size-3" /> PIN protection on
          </Badge>
        ) : (
          <Badge variant="secondary">
            <ShieldCheck className="mr-1 size-3" /> Off — account + role protection
          </Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {status.enabled ? (
          <>
            <p className="text-xs text-muted-foreground">
              The panel asks for your PIN on each new session ({status.unlockMinutes} minutes after a correct entry, per
              device).{" "}
              {typeof status.unlockedUntil === "number"
                ? `This session stays open until ${new Date(status.unlockedUntil).toLocaleTimeString()}.`
                : "This session is locked."}{" "}
              Disabling protection never weakens the server-side administrator checks — they work exactly the same with
              the PIN off.
            </p>

            {mode === "idle" && (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={busy} onClick={() => setMode("change")}>
                  <KeyRound className="mr-1 size-4" /> Change PIN
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => run(() => lock({}), "Panel locked. Your PIN is required again.")}
                >
                  <Lock className="mr-1 size-4" /> Lock panel now
                </Button>
                <Button variant="outline" className="text-destructive" disabled={busy} onClick={() => setMode("disable")}>
                  Disable PIN protection
                </Button>
              </div>
            )}

            {mode === "change" && pinFields(true)}

            {mode === "disable" && (
              <div className="space-y-3 rounded-lg border border-white/10 bg-white/[0.02] p-3">
                <div className="text-sm font-medium">Turn off Admin PIN protection</div>
                <p className="text-xs text-muted-foreground">
                  {status.accountHasPassword
                    ? "Confirm with your current PIN, or with your Freecord account password."
                    : "Confirm with your current PIN. (This account has no password credential, so if you have forgotten the PIN you can also turn protection off from the lock screen using this signed-in administrator session.)"}
                </p>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Current PIN</label>
                  <Input
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={status.maxDigits}
                    value={currentPin}
                    onChange={(e) => setCurrentPin(sanitizeAdminPinInput(e.target.value))}
                  />
                </div>
                {status.accountHasPassword && (
                  <div className="space-y-2">
                    <label className="text-sm font-medium">…or account password</label>
                    <Input
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </div>
                )}
                <ErrorLine message={error} />
                <div className="flex gap-2">
                  <Button
                    variant="destructive"
                    disabled={busy || (!currentPin && !password)}
                    onClick={() =>
                      run(
                        () => disablePin(currentPin ? { pin: currentPin } : { password }),
                        "Admin PIN protection turned off.",
                      )
                    }
                  >
                    Turn off protection
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      reset();
                      setMode("idle");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              The Admin Panel is protected by your signed-in account and its administrator role — no PIN is required and
              none will be requested.{" "}
              {status.skipped
                ? "You chose to skip PIN setup, so Freecord won't ask you again; you can still set one up below."
                : "Setting a PIN is never required."}
            </p>

            {mode === "setup" ? (
              pinFields(false)
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={busy} onClick={() => setMode("setup")}>
                  <KeyRound className="mr-1 size-4" /> {status.skipped ? "Set Up PIN" : "Enable Admin PIN"}
                </Button>
                {!status.skipped && (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => run(() => skip({}), "PIN setup skipped — Freecord won't ask again.")}
                  >
                    Skip for Now
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
