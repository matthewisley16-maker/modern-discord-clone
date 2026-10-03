import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar } from "./ui";
import { toast } from "sonner";
import { KeyRound, Mail, Monitor, Shield, Trash2, User, X } from "lucide-react";

const TABS = ["Profile", "Account", "Privacy", "Notifications", "Sessions"] as const;
type Tab = (typeof TABS)[number];

export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { signOut } = useAuth();
  const me = useQuery(api.users.me, {});
  const updateProfile = useMutation(api.users.updateProfile);
  const updateSettings = useMutation(api.users.updateSettings);
  const sessions = useQuery(api.users.mySessions, {});
  const revokeSession = useMutation(api.users.revokeSession);
  const revokeOthers = useMutation(api.users.revokeOtherSessions);
  const deleteAccount = useMutation(api.users.deleteAccount);

  const [tab, setTab] = useState<Tab>("Profile");
  const [displayName, setDisplayName] = useState(me?.profile?.displayName ?? "");
  const [bio, setBio] = useState(me?.profile?.bio ?? "");
  const [customStatus, setCustomStatus] = useState(me?.profile?.customStatus ?? "");
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);

  const s = me?.settings;

  async function saveProfile() {
    setBusy(true);
    try {
      await updateProfile({ displayName, bio, customStatus });
      toast.success("Profile saved.");
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not save."); }
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
          {tab === "Profile" && (
            <section className="fc-settings-section">
              <h3><User size={16} /> Profile</h3>
              <div className="fc-profile-preview">
                <Avatar name={displayName || me?.username || "You"} size={64} url={null} />
                <div>
                  <p className="fc-settings-username">@{me?.username}</p>
                  <p className="fc-muted">{me?.email ? me.email : "No email linked"}</p>
                </div>
              </div>
              <label>Display name<Input value={displayName} maxLength={40} onChange={(e) => setDisplayName(e.target.value)} /></label>
              <label>Bio<Input value={bio} maxLength={200} onChange={(e) => setBio(e.target.value)} placeholder="A little about you" /></label>
              <label>Custom status<Input value={customStatus} maxLength={80} onChange={(e) => setCustomStatus(e.target.value)} placeholder="What are you up to?" /></label>
              <Button onClick={saveProfile} disabled={busy}>{busy ? "Saving…" : "Save profile"}</Button>
            </section>
          )}

          {tab === "Account" && (
            <section className="fc-settings-section">
              <h3><Mail size={16} /> Account</h3>
              <p className="fc-muted">Username: <strong>@{me?.username}</strong></p>
              <div className="fc-note">
                <p><strong>Email is optional.</strong> Adding one lets you recover your account and sign in with an email code. You never need one to use Freecord.</p>
                <p className="fc-muted">Your current email: {me?.email ? me.email : "none"}</p>
              </div>
              <h3><KeyRound size={16} /> Password</h3>
              <p className="fc-muted">Passwords are hashed and can't be displayed. If you've forgotten it, use “Forgot your password?” on the sign-in page (this needs a linked email).</p>
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
