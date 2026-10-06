import { useEffect, useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar } from "./ui";
import { toSafeArray } from "@/lib/collection";
import { toast } from "sonner";
import { Eye, EyeOff, Lock, LockOpen, KeyRound, ShieldCheck, X } from "lucide-react";

/**
 * Locked & Hidden Conversations — frontend.
 *
 * Two surfaces:
 *  - `ProtectConversationDialog`  choose Lock only / Hide & lock and set or
 *    confirm the PIN for one conversation.
 *  - `SecretChatsDialog`          the PIN-gated Secret Chats screen (reached
 *    from the discreet lock button in Settings → Privacy) that lists protected
 *    conversations and manages the PIN itself.
 *
 * Every privileged step below is verified by the backend; this UI only collects
 * the PIN and reflects the server's answer. A PIN is never stored in
 * localStorage and never logged.
 */

const PIN_FILTER = (value: string) => value.replace(/\D/g, "").slice(0, 8);

function friendly(err: unknown, fallback: string): string {
  const any = err as { data?: unknown; message?: string };
  if (typeof any?.data === "string" && any.data.trim()) return any.data;
  const raw = any?.message ?? "";
  const line = raw.replace(/^\[.*?\]\s*/, "").split("\n")[0].trim();
  return line && line !== "Server Error" ? line : fallback;
}

function PinField({
  label,
  value,
  onChange,
  disabled,
  autoFocus,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const [reveal, setReveal] = useState(false);
  return (
    <label className="fc-pin-field">
      <span>{label}</span>
      <div className="fc-pin-input">
        <Input
          autoFocus={autoFocus}
          disabled={disabled}
          inputMode="numeric"
          autoComplete="off"
          type={reveal ? "text" : "password"}
          value={value}
          placeholder={placeholder ?? "••••"}
          aria-label={label}
          onChange={(e) => onChange(PIN_FILTER(e.target.value))}
        />
        <button type="button" aria-label={reveal ? "Hide PIN" : "Show PIN"} onClick={() => setReveal((v) => !v)}>
          {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Protect one conversation
// ---------------------------------------------------------------------------

export function ProtectConversationDialog({
  open,
  conversationId,
  conversationName,
  onClose,
  onProtected,
}: {
  open: boolean;
  conversationId: Id<"dmConversations"> | null;
  conversationName: string;
  onClose: () => void;
  onProtected?: () => void;
}) {
  const pinState = useQuery(api.conversationPrivacy.pinState, {});
  const protect = useAction(api.conversationPrivacy.protectConversation);

  const [mode, setMode] = useState<"lock" | "hide">("lock");
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // New protected conversations default to the account's saved preference.
  useEffect(() => {
    if (!open) return;
    setMode(pinState?.defaultHidden === false ? "lock" : "hide");
    setPin("");
    setConfirm("");
    setError("");
  }, [open, conversationId, pinState?.defaultHidden]);

  const hasPin = pinState?.hasPin === true;

  if (!open) return null;

  async function submit() {
    if (!conversationId) return;
    if (!/^\d{4,8}$/.test(pin)) { setError("Your PIN must be 4–8 digits."); return; }
    if (!hasPin && pin !== confirm) { setError("Those PINs don't match."); return; }
    setBusy(true);
    setError("");
    try {
      await protect({
        conversationId,
        hidden: mode === "hide",
        pin,
        confirmPin: hasPin ? undefined : confirm,
      });
      toast.success(mode === "hide" ? "Conversation hidden. Find it in Secret Chats." : "Conversation locked.");
      onProtected?.();
      onClose();
    } catch (err) {
      setError(friendly(err, "Could not protect this conversation."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fc-cm-confirm-overlay" onClick={busy ? undefined : onClose}>
      <div className="fc-secret-dialog" role="dialog" aria-label="Protect conversation" onClick={(e) => e.stopPropagation()}>
        <header className="fc-secret-head">
          <h3><Lock size={16} /> Protect conversation</h3>
          <button aria-label="Close" onClick={onClose} disabled={busy}><X size={16} /></button>
        </header>
        <p className="fc-muted">{conversationName}</p>

        <div className="fc-secret-modes" role="radiogroup" aria-label="Protection mode">
          <label className={`fc-secret-mode ${mode === "lock" ? "active" : ""}`}>
            <input type="radio" name="protect-mode" checked={mode === "lock"} onChange={() => setMode("lock")} />
            <span className="fc-secret-mode-icon"><LockOpen size={16} /></span>
            <span>
              <strong>Lock only</strong>
              <small>Stays visible in Chats with a lock icon. Opening it asks for your PIN.</small>
            </span>
          </label>
          <label className={`fc-secret-mode ${mode === "hide" ? "active" : ""}`}>
            <input type="radio" name="protect-mode" checked={mode === "hide"} onChange={() => setMode("hide")} />
            <span className="fc-secret-mode-icon"><Lock size={16} /></span>
            <span>
              <strong>Hide &amp; lock</strong>
              <small>Removed from Chats, search and previews. Only reachable from Secret Chats.</small>
            </span>
          </label>
        </div>

        {hasPin ? (
          <>
            <PinField label="Enter your PIN" value={pin} onChange={setPin} disabled={busy} autoFocus />
            <p className="fc-muted">Use the PIN already protecting your other conversations.</p>
          </>
        ) : (
          <>
            <p className="fc-muted">Choose a PIN for your protected conversations. It is stored only as a one-way hash.</p>
            <PinField label="Create PIN (4–8 digits)" value={pin} onChange={setPin} disabled={busy} autoFocus />
            <PinField label="Confirm PIN" value={confirm} onChange={setConfirm} disabled={busy} />
          </>
        )}

        {error && <p className="fc-secret-error" role="alert">{error}</p>}

        <div className="fc-secret-actions">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy || pin.length < 4 || (!hasPin && confirm.length < 4)}>
            {busy ? "Saving…" : mode === "hide" ? "Hide & lock" : "Lock conversation"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Secret Chats screen
// ---------------------------------------------------------------------------

type SecretRow = {
  conversationId: Id<"dmConversations">;
  name: string;
  type: string;
  hidden: boolean;
  avatarUrl: string | null;
  decorationId: string | null;
  memberCount: number;
  unread: number;
  lastMessage: string;
  lastMessageAt: number;
};

export default function SecretChatsDialog({
  open,
  onClose,
  onOpenConversation,
}: {
  open: boolean;
  onClose: () => void;
  onOpenConversation?: (id: Id<"dmConversations">) => void;
}) {
  const pinState = useQuery(api.conversationPrivacy.pinState, {});
  const secrets = useQuery(api.conversationPrivacy.secretChats, {});
  const resetAvailability = useQuery(api.conversationPrivacy.resetAvailability, {});

  const unlockSecretChats = useAction(api.conversationPrivacy.unlockSecretChats);
  const unlockConversation = useAction(api.conversationPrivacy.unlockConversation);
  const setPinAction = useAction(api.conversationPrivacy.setPin);
  const setHidden = useAction(api.conversationPrivacy.setConversationHidden);
  const unprotect = useAction(api.conversationPrivacy.unprotectConversation);
  const removePin = useAction(api.conversationPrivacy.removePin);
  const requestReset = useAction(api.conversationPrivacy.requestPinReset);
  const verifyReset = useAction(api.conversationPrivacy.verifyPinResetCode);
  const finishReset = useAction(api.conversationPrivacy.finishPinReset);
  const relock = useMutation(api.conversationPrivacy.relock);
  const updateSettings = useMutation(api.conversationPrivacy.updatePinSettings);

  // `heldPin` is the PIN the user just typed to open this screen; it is only
  // kept in memory for as long as the dialog is open, and is used for the
  // management actions the backend requires the PIN for.
  const [heldPin, setHeldPin] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [forgot, setForgot] = useState<null | "confirm" | "code" | "done">(null);
  const [resetCode, setResetCode] = useState("");
  const [changeOpen, setChangeOpen] = useState(false);
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmNewPin, setConfirmNewPin] = useState("");
  const [createPin, setCreatePin] = useState("");
  const [createConfirm, setCreateConfirm] = useState("");

  const unlocked = secrets?.unlocked === true;
  const mustChangePin = secrets?.mustChangePin === true || pinState?.mustChangePin === true;
  // Normalized: a malformed Secret Chats payload can never crash the list.
  const rows = toSafeArray<SecretRow>(secrets?.conversations, { label: "Secret chats", source: "api.conversationPrivacy.secretChats" });

  useEffect(() => {
    if (open) return;
    // Closing the screen forgets the in-memory PIN.
    setHeldPin("");
    setPin("");
    setError("");
    setForgot(null);
    setResetCode("");
    setChangeOpen(false);
    setCurrentPin("");
    setNewPin("");
    setConfirmNewPin("");
    setCreatePin("");
    setCreateConfirm("");
  }, [open]);

  const hiddenCount = useMemo(() => rows.filter((r) => r.hidden).length, [rows]);

  if (!open) return null;

  async function guard<T>(fn: () => Promise<T>, fallback: string): Promise<T | null> {
    setBusy(true);
    setError("");
    try {
      return await fn();
    } catch (err) {
      setError(friendly(err, fallback));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function submitUnlockGate(e: React.FormEvent) {
    e.preventDefault();
    const res = await guard(() => unlockSecretChats({ pin }), "Could not unlock Secret Chats.");
    if (!res) return;
    setHeldPin(pin);
    if (res.granted) {
      setPin("");
      setForgot(null);
    } else {
      // The temporary PIN was accepted but nothing was revealed: the new-PIN
      // step is required next (keep `heldPin` as the current PIN).
      setForgot(null);
    }
  }

  /** Complete a PIN reset: replaces the temporary PIN and opens Secret Chats. */
  async function completeReset(e: React.FormEvent) {
    e.preventDefault();
    if (newPin !== confirmNewPin) { setError("Those PINs don't match."); return; }
    const res = await guard(
      () => finishReset({ currentPin: currentPin || heldPin || "0000", pin: newPin, confirmPin: confirmNewPin }),
      "Could not save the new PIN.",
    );
    if (res) {
      toast.success("New PIN saved.");
      setHeldPin(newPin);
      setCurrentPin("");
      setNewPin("");
      setConfirmNewPin("");
    }
  }

  async function createFirstPin(e: React.FormEvent) {
    e.preventDefault();
    if (createPin !== createConfirm) { setError("Those PINs don't match."); return; }
    const res = await guard(() => setPinAction({ pin: createPin, confirmPin: createConfirm }), "Could not save the PIN.");
    if (res) {
      toast.success("PIN saved. Protect a conversation to use it.");
      setHeldPin(createPin);
      setCreatePin("");
      setCreateConfirm("");
    }
  }

  async function changePinNow(e: React.FormEvent) {
    e.preventDefault();
    if (newPin !== confirmNewPin) { setError("Those PINs don't match."); return; }
    const res = await guard(
      () => setPinAction({ pin: newPin, confirmPin: confirmNewPin, currentPin }),
      "Could not change the PIN.",
    );
    if (res) {
      toast.success("PIN changed.");
      setHeldPin(newPin);
      setChangeOpen(false);
      setCurrentPin("");
      setNewPin("");
      setConfirmNewPin("");
    }
  }

  async function sendResetCode() {
    const res = await guard(() => requestReset({}), "Could not send the reset email.");
    if (res) {
      toast.success(`Reset code sent to ${resetAvailability?.email ?? "your email"}.`);
      setForgot("code");
    }
  }

  async function submitResetCode(e: React.FormEvent) {
    e.preventDefault();
    const res = await guard(() => verifyReset({ code: resetCode }), "That reset code could not be verified.");
    if (res) {
      setForgot("done");
      setResetCode("");
      setHeldPin("");
    }
  }

  async function toggleHidden(row: SecretRow) {
    if (!heldPin) { setError("Enter your PIN to manage conversations."); return; }
    const res = await guard(
      () => setHidden({ conversationId: row.conversationId, hidden: !row.hidden, pin: heldPin }),
      "Could not update that conversation.",
    );
    if (res) toast.success(row.hidden ? "Conversation is visible in Chats again." : "Conversation hidden.");
  }

  async function unlockRow(row: SecretRow) {
    if (!heldPin) { setError("Enter your PIN to unlock a conversation."); return; }
    const res = await guard(
      () => unlockConversation({ conversationId: row.conversationId, pin: heldPin }),
      "Could not unlock that conversation.",
    );
    if (res) { toast.success("Conversation unlocked."); onOpenConversation?.(row.conversationId); }
  }

  async function releaseRow(row: SecretRow) {
    if (!heldPin) { setError("Enter your PIN to remove protection."); return; }
    if (!window.confirm(`Remove protection from “${row.name}”? It will appear in Chats again.`)) return;
    const res = await guard(
      () => unprotect({ conversationId: row.conversationId, pin: heldPin }),
      "Could not remove protection.",
    );
    if (res) toast.success("Protection removed.");
  }

  async function removePinEntirely() {
    if (!heldPin) { setError("Enter your PIN first."); return; }
    if (!window.confirm("Remove your PIN and release every protected conversation?")) return;
    const res = await guard(() => removePin({ pin: heldPin }), "Could not remove the PIN.");
    if (res) { toast.success("PIN removed."); setHeldPin(""); }
  }

  return (
    <div className="fc-cm-confirm-overlay" onClick={busy ? undefined : onClose}>
      <div className="fc-secret-screen" role="dialog" aria-label="Secret Chats" onClick={(e) => e.stopPropagation()}>
        <header className="fc-secret-head">
          <h3><Lock size={16} /> Secret Chats</h3>
          <button aria-label="Close Secret Chats" onClick={onClose} disabled={busy}><X size={16} /></button>
        </header>

        {/* ---- PIN gate: nothing is shown until the server confirms the PIN ---- */}
        {!unlocked && (
          <div className="fc-secret-gate">
            {pinState?.hasPin === false ? (
              <>
                <span className="fc-secret-gate-icon"><KeyRound size={24} /></span>
                <h4>Create your PIN</h4>
                <p className="fc-muted">
                  A PIN protects the conversations you lock. It is hashed on the server and never stored in plain text.
                </p>
                <form onSubmit={createFirstPin} className="fc-secret-form">
                  <PinField label="New PIN (4–8 digits)" value={createPin} onChange={setCreatePin} disabled={busy} autoFocus />
                  <PinField label="Confirm PIN" value={createConfirm} onChange={setCreateConfirm} disabled={busy} />
                  <Button type="submit" disabled={busy || createPin.length < 4 || createPin !== createConfirm}>Save PIN</Button>
                </form>
              </>
            ) : forgot === "done" ? (
              <>
                <span className="fc-secret-gate-icon"><KeyRound size={24} /></span>
                <h4>Your temporary PIN is 0000</h4>
                <p className="fc-muted">
                  Enter <strong>0000</strong> below and you&apos;ll immediately be asked to choose a new PIN.
                </p>
                <form onSubmit={submitUnlockGate} className="fc-secret-form">
                  <PinField label="Enter PIN" value={pin} onChange={setPin} disabled={busy} autoFocus />
                  <Button type="submit" disabled={busy || pin.length < 4}>{busy ? "Checking…" : "Unlock"}</Button>
                </form>
              </>
            ) : mustChangePin ? (
              <>
                <span className="fc-secret-gate-icon"><KeyRound size={24} /></span>
                <h4>Choose a new PIN</h4>
                <p className="fc-muted">
                  Your PIN is still the temporary <strong>0000</strong>. Confirm it and set a PIN of your own — Secret
                  Chats stays locked until you do.
                </p>
                <form onSubmit={completeReset} className="fc-secret-form">
                  <PinField label="Current (temporary) PIN" value={currentPin} onChange={setCurrentPin} disabled={busy} placeholder="0000" />
                  <PinField label="New PIN (4–8 digits)" value={newPin} onChange={setNewPin} disabled={busy} autoFocus />
                  <PinField label="Confirm new PIN" value={confirmNewPin} onChange={setConfirmNewPin} disabled={busy} />
                  <Button type="submit" disabled={busy || newPin.length < 4 || newPin !== confirmNewPin}>Save new PIN</Button>
                </form>
              </>
            ) : forgot ? (
              <>
                <span className="fc-secret-gate-icon"><ShieldCheck size={24} /></span>
                <h4>Reset your PIN</h4>
                {forgot === "confirm" ? (
                  <>
                    <p className="fc-muted">
                      We&apos;ll email a 6-digit reset code to your account address
                      {resetAvailability?.email ? <> (<strong>{resetAvailability.email}</strong>)</> : null}. The code expires
                      in 15 minutes.
                    </p>
                    {!resetAvailability?.hasEmail ? (
                      <p className="fc-secret-error" role="alert">
                        This account has no email address, so a reset code can&apos;t be sent. Add an email in
                        Settings → Account first.
                      </p>
                    ) : null}
                    <div className="fc-secret-actions">
                      <Button variant="ghost" onClick={() => setForgot(null)} disabled={busy}>Back</Button>
                      <Button onClick={sendResetCode} disabled={busy || !resetAvailability?.hasEmail}>
                        {busy ? "Sending…" : "Email me a reset code"}
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="fc-muted">Enter the 6-digit code we emailed you.</p>
                    <form onSubmit={submitResetCode} className="fc-secret-form">
                      <PinField label="Reset code" value={resetCode} onChange={(v) => setResetCode(v.slice(0, 6))} disabled={busy} autoFocus placeholder="123456" />
                      <Button type="submit" disabled={busy || resetCode.length !== 6}>Verify code</Button>
                    </form>
                    <button className="fc-link-btn" onClick={() => setForgot("confirm")} disabled={busy}>Send a new code</button>
                  </>
                )}
              </>
            ) : (
              <>
                <span className="fc-secret-gate-icon"><Lock size={24} /></span>
                <h4>Enter your PIN</h4>
                <p className="fc-muted">
                  {pinState?.hiddenCount
                    ? `${pinState.hiddenCount} hidden conversation${pinState.hiddenCount === 1 ? "" : "s"} waiting.`
                    : "Your protected conversations stay hidden until you unlock them."}
                </p>
                <form onSubmit={submitUnlockGate} className="fc-secret-form">
                  <PinField label="PIN" value={pin} onChange={setPin} disabled={busy} autoFocus />
                  <Button type="submit" disabled={busy || pin.length < 4}>{busy ? "Checking…" : "Unlock"}</Button>
                </form>
                <button className="fc-link-btn" onClick={() => setForgot("confirm")} disabled={busy}>Forgot PIN?</button>
              </>
            )}
            {error && <p className="fc-secret-error" role="alert">{error}</p>}
          </div>
        )}

        {/* ---- Unlocked: hidden / locked conversations + management ---- */}
        {unlocked && (
          <>
            <div className="fc-secret-body">
              <p className="fc-secret-summary">
                <Lock size={13} /> {rows.length} protected · {hiddenCount} hidden
              </p>
              {rows.length === 0 && (
                <p className="fc-muted">
                  No protected conversations yet. Use the lock action on any conversation to lock it or hide it.
                </p>
              )}
              {rows.map((row) => (
                <div key={row.conversationId} className="fc-secret-row">
                  <Avatar name={row.name} size={30} url={row.avatarUrl ?? undefined} decorationId={row.decorationId} />
                  <div className="fc-secret-row-main">
                    <span className="fc-secret-row-name">
                      <Lock size={12} /> {row.name}
                      {row.hidden && <em className="fc-secret-flag">Hidden</em>}
                    </span>
                    <small>{row.lastMessage || "No preview"}</small>
                  </div>
                  <div className="fc-secret-row-tools">
                    <button onClick={() => unlockRow(row)} disabled={busy} title="Unlock for this session">Unlock</button>
                    <button
                      onClick={() => void guard(() => relock({ conversationId: row.conversationId }), "Could not lock that conversation.")}
                      disabled={busy}
                      title="Lock again now"
                    >Lock</button>
                    <button onClick={() => toggleHidden(row)} disabled={busy} title={row.hidden ? "Show in Chats" : "Hide from Chats"}>
                      {row.hidden ? "Unhide" : "Hide"}
                    </button>
                    <button onClick={() => releaseRow(row)} disabled={busy} className="danger" title="Remove protection">Remove</button>
                  </div>
                </div>
              ))}

              <span className="fc-secret-section-title">Security</span>

              <label className="fc-toggle-row">
                <span>
                  <strong>Hide new protected conversations</strong>
                  <small>When on, locking a conversation hides it from Chats by default.</small>
                </span>
                <input
                  type="checkbox"
                  className="fc-switch"
                  checked={pinState?.defaultHidden !== false}
                  disabled={busy}
                  onChange={(e) => void guard(() => updateSettings({ defaultHidden: e.target.checked }), "Could not save.")}
                />
              </label>

              <label className="fc-select-row">
                Auto-lock after
                <select
                  className="fc-select"
                  value={String(pinState?.autoLockMinutes ?? 15)}
                  disabled={busy}
                  onChange={(e) => void guard(() => updateSettings({ autoLockMinutes: Number(e.target.value) }), "Could not save.")}
                >
                  {[1, 5, 15, 30, 60, 120].map((m) => (
                    <option key={m} value={m}>{m >= 60 ? `${m / 60} hour${m === 60 ? "" : "s"}` : `${m} minutes`}</option>
                  ))}
                </select>
              </label>
              <p className="fc-muted">Unlocking is per session — signing out or using another device locks everything again.</p>

              <div className="fc-secret-actions wrap">
                <Button variant="outline" onClick={() => { setChangeOpen((v) => !v); setError(""); }}>
                  <KeyRound size={15} /> Change PIN
                </Button>
                <Button variant="ghost" onClick={() => void guard(() => relock({}), "Could not re-lock.")} disabled={busy}>
                  Re-lock everything now
                </Button>
                <Button variant="ghost" className="text-destructive" onClick={removePinEntirely} disabled={busy}>
                  Remove PIN &amp; release all
                </Button>
              </div>

              {changeOpen && (
                <form onSubmit={changePinNow} className="fc-secret-form fc-secret-change">
                  <PinField label="Current PIN" value={currentPin} onChange={setCurrentPin} disabled={busy} />
                  <PinField label="New PIN (4–8 digits)" value={newPin} onChange={setNewPin} disabled={busy} />
                  <PinField label="Confirm new PIN" value={confirmNewPin} onChange={setConfirmNewPin} disabled={busy} />
                  <Button type="submit" disabled={busy || newPin.length < 4 || newPin !== confirmNewPin}>Update PIN</Button>
                </form>
              )}

              {error && <p className="fc-secret-error" role="alert">{error}</p>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
