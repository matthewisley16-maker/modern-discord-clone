import { useEffect, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar } from "./ui";
import { toast } from "sonner";
import { Eye, EyeOff, KeyRound, Lock, Mail, Mic, Monitor, Palette, Settings2, Shield, Trash2, User, X } from "lucide-react";
import SecretChatsDialog from "./SecretChats";

const TABS = ["General", "Profile", "Appearance", "Notifications", "Privacy", "Voice & Video", "Account", "Sessions"] as const;
type Tab = (typeof TABS)[number];

export default function SettingsPanel({ onClose, onEditProfile }: { onClose: () => void; onEditProfile?: () => void }) {
  const { signOut } = useAuth();
  const me = useQuery(api.users.me, {});
  const updateProfile = useMutation(api.users.updateProfile);
  const updateSettings = useMutation(api.users.updateSettings);
  const sessions = useQuery(api.users.mySessions, {});
  const revokeSession = useMutation(api.users.revokeSession);
  const revokeOthers = useMutation(api.users.revokeOtherSessions);
  const deleteAccount = useMutation(api.users.deleteAccount);
  const setUsername = useMutation(api.users.setUsername);
  const setDisplayNameOnly = useMutation(api.users.setDisplayName);

  // ---- Password (Set for accounts without one, Change for accounts with one) ----
  const passwordState = useQuery(api.passwords.passwordState, {});
  const setPassword = useAction(api.passwords.setPassword);
  const changePassword = useAction(api.passwords.changePassword);
  const [pwOpen, setPwOpen] = useState(false);
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwShow, setPwShow] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);
  const pwRuleOk = pwNew.length >= 8 && /[a-zA-Z]/.test(pwNew) && /[0-9]/.test(pwNew);
  const pwMatch = pwNew.length > 0 && pwNew === pwConfirm;

  function resetPwForm() {
    setPwCurrent("");
    setPwNew("");
    setPwConfirm("");
    setPwShow(false);
  }

  async function submitPassword() {
    if (!pwRuleOk) { toast.error("Password must be at least 8 characters and include a letter and a number."); return; }
    if (!pwMatch) { toast.error("Those passwords don't match."); return; }
    setPwBusy(true);
    try {
      if (passwordState?.hasPassword) {
        await changePassword({ currentPassword: pwCurrent, newPassword: pwNew });
        toast.success("Password updated.");
      } else {
        await setPassword({ password: pwNew });
        toast.success("Password set. You can now sign in with it.");
      }
      // The live query flips this section to "Password is set" with no refresh.
      setPwOpen(false);
      resetPwForm();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update your password.");
    } finally {
      setPwBusy(false);
    }
  }

  const appearance = useQuery(api.profiles.getAppearance, {});
  const updateAppearance = useMutation(api.profiles.updateAppearance);

  const [tab, setTab] = useState<Tab>("General");
  // Discreet entry point to the PIN-gated Secret Chats screen (Privacy tab).
  const [secretOpen, setSecretOpen] = useState(false);
  const [displayName, setDisplayName] = useState(me?.profile?.displayName ?? "");
  const [bio, setBio] = useState(me?.profile?.bio ?? "");
  const [customStatus, setCustomStatus] = useState(me?.profile?.customStatus ?? "");
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);
  // Separate identity fields — editing one never overwrites the other.
  const [usernameDraft, setUsernameDraft] = useState("");
  const [usernameTouched, setUsernameTouched] = useState(false);
  useEffect(() => {
    if (!usernameTouched && me?.username) setUsernameDraft(me.username);
  }, [me?.username, usernameTouched]);
  const usernameCheck = useQuery(
    api.users.usernameAvailable,
    usernameDraft.trim() ? { username: usernameDraft.trim() } : "skip",
  );

  const s = me?.settings;

  // Local mirror of appearance settings so the controls feel instant; each
  // change is also written to the backend for that account.
  const [theme, setTheme] = useState("dark");
  const [density, setDensity] = useState("comfortable");
  const [fontSize, setFontSize] = useState(14);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [accent, setAccent] = useState("#7c5cf6");
  useEffect(() => {
    if (!appearance) return;
    if (appearance.theme) setTheme(appearance.theme);
    if (appearance.density) setDensity(appearance.density);
    if (typeof appearance.fontSize === "number") setFontSize(appearance.fontSize);
    if (typeof appearance.reducedMotion === "boolean") setReducedMotion(appearance.reducedMotion);
    if (appearance.customColors?.accent) setAccent(appearance.customColors.accent);
  }, [appearance]);

  async function saveAppearance(patch: Parameters<typeof updateAppearance>[0]) {
    try { await updateAppearance(patch); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Could not save appearance."); }
  }

  async function saveProfile() {
    setBusy(true);
    try {
      await updateProfile({ displayName, bio, customStatus });
      toast.success("Profile saved.");
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not save."); }
    finally { setBusy(false); }
  }

  async function saveUsername() {
    setBusy(true);
    try {
      await setUsername({ username: usernameDraft.trim() });
      toast.success("Username updated.");
      setUsernameTouched(false);
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not update username."); }
    finally { setBusy(false); }
  }

  async function saveDisplayName() {
    setBusy(true);
    try {
      await setDisplayNameOnly({ displayName: displayName.trim() });
      toast.success("Display name updated.");
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not update display name."); }
    finally { setBusy(false); }
  }

  async function setPref(key: string, value: unknown) {
    try { await updateSettings({ [key]: value } as never); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Could not save."); }
  }

  async function handleDelete() {
    if (!window.confirm("Delete your account and all of your data? This cannot be undone.")) return;
    setBusy(true);
    try {
      await deleteAccount({ confirmUsername: confirmName });
      toast.success("Your account was deleted.");
      await signOut();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not delete account."); }
    finally { setBusy(false); }
  }

  return (
    <div className="fc-settings" role="dialog" aria-label="Settings">
      <header className="fc-settings-head">
        <h2>Settings</h2>
        <button aria-label="Close settings" onClick={onClose}><X size={18} /></button>
      </header>
      <div className="fc-settings-body">
        <nav className="fc-settings-tabs" aria-label="Settings sections">
          {TABS.map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{t}</button>
          ))}
        </nav>

        <div className="fc-settings-content">
          {tab === "General" && (
            <section className="fc-settings-section">
              <h3><Settings2 size={16} /> General</h3>
              <div className="fc-profile-preview">
                <Avatar name={me?.profile?.displayName ?? me?.username ?? "You"} size={64} url={me?.avatarUrl} decorationId={me?.profile?.decorationId ?? null} />
                <div>
                  <p className="fc-settings-username">@{me?.username}</p>
                  <p className="fc-muted">{me?.email ? me.email : "No email linked"}</p>
                </div>
              </div>
              <label className="fc-select-row">Theme
                <select className="fc-select" value={theme} onChange={(e) => { setTheme(e.target.value); void saveAppearance({ theme: e.target.value }); }}>
                  <option value="system">System / default</option>
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                  <option value="midnight">Midnight</option>
                  <option value="contrast">High contrast</option>
                </select>
              </label>
              <label className="fc-select-row">Interface density
                <select className="fc-select" value={density} onChange={(e) => { setDensity(e.target.value); void saveAppearance({ density: e.target.value }); }}>
                  <option value="comfortable">Comfortable</option>
                  <option value="compact">Compact</option>
                </select>
              </label>
              <Button variant="outline" onClick={onEditProfile}>Open the full profile editor</Button>
              <p className="fc-muted">General preferences save to your account and follow you between devices.</p>
              <Button variant="ghost" onClick={async () => { await signOut(); }}>Sign out</Button>
            </section>
          )}

          {tab === "Appearance" && (
            <section className="fc-settings-section">
              <h3><Palette size={16} /> Appearance</h3>
              <p className="fc-muted">Theme changes apply immediately and are saved to your account.</p>
              <span className="fc-field-label">Theme</span>
              <div className="fc-radio-row">
                {([["system", "System"], ["dark", "Dark"], ["light", "Light"], ["midnight", "Midnight"], ["contrast", "High contrast"]] as const).map(([value, label]) => (
                  <label key={value} className={`fc-radio ${theme === value ? "active" : ""}`}>
                    <input type="radio" name="theme" checked={theme === value} onChange={() => { setTheme(value); void saveAppearance({ theme: value }); }} />
                    {label}
                  </label>
                ))}
              </div>
              <label className="fc-select-row">Interface density
                <select className="fc-select" value={density} onChange={(e) => { setDensity(e.target.value); void saveAppearance({ density: e.target.value }); }}>
                  <option value="comfortable">Comfortable</option>
                  <option value="compact">Compact</option>
                </select>
              </label>
              <label className="fc-select-row">Font size — {fontSize}px
                <input
                  type="range" min={12} max={20} step={1} value={fontSize}
                  onChange={(e) => setFontSize(Number(e.target.value))}
                  onMouseUp={() => void saveAppearance({ fontSize })}
                  onTouchEnd={() => void saveAppearance({ fontSize })}
                />
              </label>
              <label className="fc-select-row">Accent colour
                <input
                  type="color" value={accent}
                  onChange={(e) => { setAccent(e.target.value); void saveAppearance({ customColors: { accent: e.target.value } }); }}
                />
              </label>
              <label className="fc-toggle-row">
                <span><strong>Reduce motion</strong><small>Turn off decorative animations and profile effects.</small></span>
                <input
                  type="checkbox" className="fc-switch" checked={reducedMotion}
                  onChange={(e) => { setReducedMotion(e.target.checked); void saveAppearance({ reducedMotion: e.target.checked }); }}
                />
              </label>
            </section>
          )}

          {tab === "Voice & Video" && (
            <section className="fc-settings-section">
              <h3><Mic size={16} /> Voice &amp; Video</h3>
              <p className="fc-muted">These preferences are saved to your account and applied the next time you join voice.</p>
              <label className="fc-toggle-row">
                <span><strong>Echo cancellation</strong><small>Reduce echo from your speakers.</small></span>
                <input type="checkbox" className="fc-switch" defaultChecked={(s as never as Record<string, boolean>)?.voiceEchoCancellation !== false} onChange={(e) => setPref("voiceEchoCancellation", e.target.checked)} />
              </label>
              <label className="fc-toggle-row">
                <span><strong>Noise suppression</strong><small>Filter out background noise.</small></span>
                <input type="checkbox" className="fc-switch" defaultChecked={(s as never as Record<string, boolean>)?.voiceNoiseSuppression !== false} onChange={(e) => setPref("voiceNoiseSuppression", e.target.checked)} />
              </label>
              <label className="fc-toggle-row">
                <span><strong>Mute my microphone on join</strong><small>Join voice rooms muted by default.</small></span>
                <input type="checkbox" className="fc-switch" defaultChecked={(s as never as Record<string, boolean>)?.voiceAutoMute === true} onChange={(e) => setPref("voiceAutoMute", e.target.checked)} />
              </label>
              <label className="fc-select-row">Input volume — {Math.round(((s?.voiceInputVolume ?? 1) as number) * 100)}%
                <input
                  type="range" min={0} max={1} step={0.05}
                  defaultValue={(s?.voiceInputVolume ?? 1) as number}
                  onMouseUp={(e) => setPref("voiceInputVolume", Number((e.target as HTMLInputElement).value))}
                  onTouchEnd={(e) => setPref("voiceInputVolume", Number((e.target as HTMLInputElement).value))}
                />
              </label>
              <p className="fc-muted">The speaking indicator is driven by your real microphone activity.</p>
            </section>
          )}

          {tab === "Profile" && (
            <section className="fc-settings-section">
              <h3><User size={16} /> Profile</h3>
              <div className="fc-profile-preview">
                <Avatar name={displayName || me?.username || "You"} size={64} url={me?.avatarUrl} decorationId={me?.profile?.decorationId ?? null} />
                <div>
                  <p className="fc-settings-username">@{me?.username}</p>
                  <p className="fc-muted">{me?.email ? me.email : "No email linked"}</p>
                </div>
              </div>
              <Button variant="outline" onClick={onEditProfile}>Open the full profile editor</Button>
              <p className="fc-muted">Customize your avatar, banner, colors, nameplate, badges and widgets.</p>
              <label>Display name<Input value={displayName} maxLength={40} onChange={(e) => setDisplayName(e.target.value)} /></label>
              <label>Bio<Input value={bio} maxLength={200} onChange={(e) => setBio(e.target.value)} placeholder="A little about you" /></label>
              <label>Custom status<Input value={customStatus} maxLength={80} onChange={(e) => setCustomStatus(e.target.value)} placeholder="What are you up to?" /></label>
              <Button onClick={saveProfile} disabled={busy}>{busy ? "Saving…" : "Save profile"}</Button>
            </section>
          )}

          {tab === "Account" && (
            <section className="fc-settings-section">
              <h3><Mail size={16} /> Account</h3>

              <span className="fc-field-label">Username — your unique identifier</span>
              <div className="fc-input-prefixed">
                <span aria-hidden="true">@</span>
                <Input
                  value={usernameDraft}
                  maxLength={24}
                  disabled={busy}
                  aria-label="Username"
                  onChange={(e) => { setUsernameTouched(true); setUsernameDraft(e.target.value.toLowerCase()); }}
                />
              </div>
              {usernameTouched && usernameDraft.trim() && (
                usernameCheck && !usernameCheck.available
                  ? <p className="text-xs text-destructive">{usernameCheck.reason ?? "That username isn't available."}</p>
                  : <p className="fc-muted">@{usernameDraft.trim()} is available.</p>
              )}
              <Button
                onClick={saveUsername}
                disabled={busy || !usernameTouched || !usernameCheck?.available || usernameDraft.trim() === (me?.username ?? "")}
              >{busy ? "Saving…" : "Change username"}</Button>
              <p className="fc-muted">Unique across Freecord. Changing it never changes your display name.</p>

              <span className="fc-field-label">Display name — what everyone sees</span>
              <Input value={displayName} maxLength={40} disabled={busy} aria-label="Display name" onChange={(e) => setDisplayName(e.target.value)} />
              <Button
                variant="outline"
                onClick={saveDisplayName}
                disabled={busy || !displayName.trim() || displayName.trim() === (me?.profile?.displayName ?? "")}
              >{busy ? "Saving…" : "Change display name"}</Button>
              <p className="fc-muted">Display names don't need to be unique. Your email is never shown as your name.</p>
              <div className="fc-note">
                <p><strong>Email is optional.</strong> Adding one lets you recover your account and sign in with an email code. You never need one to use Freecord.</p>
                <p className="fc-muted">Your current email: {me?.email ? me.email : "none"}</p>
              </div>
              <h3><KeyRound size={16} /> Password</h3>
              {passwordState === undefined && <p className="fc-muted">Checking your password…</p>}
              {passwordState !== undefined && passwordState !== null && !pwOpen && (
                <>
                  <p className="fc-muted">
                    {passwordState.hasPassword
                      ? "Password is set. You can sign in with your username — or your email — and this password."
                      : "No password is currently set for this account. Add one to sign in without an email code — your account, data and profile stay exactly the same."}
                  </p>
                  {passwordState.email && !passwordState.emailVerified && (
                    <p className="fc-muted">
                      Your email isn&apos;t verified yet. Verify it to be able to reset your password if you ever forget it.
                    </p>
                  )}
                  <Button
                    variant={passwordState.hasPassword ? "outline" : "default"}
                    onClick={() => { resetPwForm(); setPwOpen(true); }}
                  >
                    {passwordState.hasPassword ? "Change Password" : "Set Password"}
                  </Button>
                </>
              )}
              {passwordState !== undefined && passwordState !== null && pwOpen && (
                <div className="fc-pw-form">
                  {passwordState.hasPassword && (
                    <label>Current password
                      <Input
                        type={pwShow ? "text" : "password"}
                        value={pwCurrent}
                        autoComplete="current-password"
                        onChange={(e) => setPwCurrent(e.target.value)}
                      />
                    </label>
                  )}
                  <label>New password
                    <div className="fc-pw-input">
                      <Input
                        type={pwShow ? "text" : "password"}
                        value={pwNew}
                        autoComplete="new-password"
                        onChange={(e) => setPwNew(e.target.value)}
                      />
                      <button
                        type="button"
                        aria-label={pwShow ? "Hide passwords" : "Show passwords"}
                        onClick={() => setPwShow((v) => !v)}
                      >
                        {pwShow ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </label>
                  <label>Confirm password
                    <Input
                      type={pwShow ? "text" : "password"}
                      value={pwConfirm}
                      autoComplete="new-password"
                      onChange={(e) => setPwConfirm(e.target.value)}
                    />
                  </label>
                  <p className="fc-muted">At least 8 characters, including at least one letter and one number.</p>
                  {pwConfirm.length > 0 && !pwMatch && <p className="text-xs text-destructive">Those passwords don&apos;t match.</p>}
                  <div className="fc-pw-actions">
                    <Button
                      onClick={submitPassword}
                      disabled={pwBusy || !pwRuleOk || !pwMatch || (passwordState.hasPassword && !pwCurrent)}
                    >
                      {pwBusy ? "Saving…" : passwordState.hasPassword ? "Update password" : "Set password"}
                    </Button>
                    <Button variant="ghost" disabled={pwBusy} onClick={() => { setPwOpen(false); resetPwForm(); }}>Cancel</Button>
                  </div>
                </div>
              )}
              <h3 className="danger-heading"><Trash2 size={16} /> Delete account</h3>
              <p className="fc-muted">This permanently deletes your profile, messages, and communities you own. Type your username to confirm.</p>
              <div className="fc-delete-row">
                <Input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={me?.username ?? "username"} />
                <Button variant="destructive" disabled={busy || !confirmName.trim()} onClick={handleDelete}>Delete account</Button>
              </div>
            </section>
          )}

          {tab === "Privacy" && (
            <section className="fc-settings-section">
              <h3><Shield size={16} /> Privacy</h3>
              {[
                { key: "searchable", label: "Appear in search", hint: "Let people find you by username or display name." },
                { key: "publicProfile", label: "Public profile", hint: "Allow anyone to view your profile." },
                { key: "presenceVisible", label: "Show my presence", hint: "Display your online status to others." },
                { key: "readReceipts", label: "Read receipts", hint: "Let others see when you've read a message." },
                { key: "activityVisible", label: "Activity visibility", hint: "Show what you're currently doing." },
              ].map((row) => (
                <label key={row.key} className="fc-toggle-row">
                  <span><strong>{row.label}</strong><small>{row.hint}</small></span>
                  <input type="checkbox" className="fc-switch" defaultChecked={(s as never as Record<string, boolean>)?.[row.key] !== false} onChange={(e) => setPref(row.key, e.target.checked)} />
                </label>
              ))}
              <label className="fc-select-row">Who can DM you
                <select defaultValue={s?.dmPrivacy ?? "everyone"} onChange={(e) => setPref("dmPrivacy", e.target.value)}>
                  <option value="everyone">Everyone</option>
                  <option value="friends">Friends only</option>
                  <option value="none">No one</option>
                </select>
              </label>
              <label className="fc-select-row">Who can send friend requests
                <select defaultValue={s?.friendRequestPrivacy ?? "everyone"} onChange={(e) => setPref("friendRequestPrivacy", e.target.value)}>
                  <option value="everyone">Everyone</option>
                  <option value="mutual">People with mutual communities</option>
                  <option value="none">No one</option>
                </select>
              </label>
              <label className="fc-select-row">Who can follow you
                <select defaultValue={s?.followPrivacy ?? "everyone"} onChange={(e) => setPref("followPrivacy", e.target.value)}>
                  <option value="everyone">Everyone</option>
                  <option value="none">No one</option>
                </select>
              </label>
              <p className="fc-muted">These settings are enforced on the server.</p>

              {/* Small, discreet lock icon — the Secret Chats entry point. */}
              <div className="fc-secret-entry">
                <button
                  type="button"
                  className="fc-secret-entry-btn"
                  aria-label="Secret Chats — locked and hidden conversations"
                  title="Secret Chats"
                  onClick={() => setSecretOpen(true)}
                >
                  <Lock size={13} />
                </button>
              </div>
            </section>
          )}

          {tab === "Notifications" && (
            <section className="fc-settings-section">
              <h3>Notifications</h3>
              {[
                { key: "notifyFriendRequests", label: "Friend requests", hint: "Requests and acceptances." },
                { key: "notifyDMs", label: "Direct messages", hint: "New DMs from friends." },
                { key: "notifyMentions", label: "Mentions and replies", hint: "When someone mentions or replies to you." },
                { key: "notifyInvites", label: "Community invites", hint: "Invites and announcements." },
                { key: "notifyFollows", label: "New followers", hint: "When someone follows you." },
                { key: "notifyCalls", label: "Call invitations", hint: "Voice and video call invites." },
              ].map((row) => (
                <label key={row.key} className="fc-toggle-row">
                  <span><strong>{row.label}</strong><small>{row.hint}</small></span>
                  <input type="checkbox" className="fc-switch" defaultChecked={(s as never as Record<string, boolean>)?.[row.key] !== false} onChange={(e) => setPref(row.key, e.target.checked)} />
                </label>
              ))}
            </section>
          )}

          {tab === "Privacy" && (
            <SecretChatsDialog open={secretOpen} onClose={() => setSecretOpen(false)} />
          )}

          {tab === "Sessions" && (
            <section className="fc-settings-section">
              <h3><Monitor size={16} /> Sessions & devices</h3>
              <p className="fc-muted">You can revoke any session you don't recognize.</p>
              {(sessions ?? []).map((sess) => (
                <div key={sess.sessionId} className="fc-session-row">
                  <div>
                    <p><strong>{sess.current ? "This device" : "Other session"}</strong></p>
                    <p className="fc-muted">Started {new Date(sess.createdAt).toLocaleString()} · expires {new Date(sess.expiresAt).toLocaleDateString()}</p>
                  </div>
                  {!sess.current && (
                    <Button size="sm" variant="outline" onClick={async () => {
                      try { await revokeSession({ sessionId: sess.sessionId }); toast.success("Session revoked."); }
                      catch (e) { toast.error(e instanceof Error ? e.message : "Failed."); }
                    }}>Revoke</Button>
                  )}
                </div>
              ))}
              <Button variant="outline" onClick={async () => {
                try { await revokeOthers({}); toast.success("All other sessions revoked."); }
                catch (e) { toast.error(e instanceof Error ? e.message : "Failed."); }
              }}>Sign out all other sessions</Button>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
