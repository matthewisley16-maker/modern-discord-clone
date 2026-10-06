import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import ProfileAvatar from "./ProfileAvatar";
import ProfileEffect from "./ProfileEffect";
import { BADGES, DECORATIONS, EFFECTS, FRAMES, NAME_EFFECTS, NAME_FONTS, NAMEPLATES, THEMES, WIDGET_TYPES, nameStyle, plateStyle } from "@/lib/cosmetics";
import { toSafeArray } from "@/lib/collection";
import { toast } from "sonner";
import { ImagePlus, RotateCcw, Save, Trash2, X } from "lucide-react";

const MAX_IMAGE = 5 * 1024 * 1024;
const VISIBILITY = [
  { value: "everyone", label: "Everyone" },
  { value: "friends", label: "Friends" },
  { value: "mutual", label: "Friends + shared communities" },
  { value: "none", label: "Nobody except me" },
];

type Draft = {
  displayName: string; bio: string; pronouns: string; customStatus: string;
  interests: string; socialLinks: { label: string; url: string }[];
  theme: string; decorationId: string; frameId: string; effectId: string; nameplateId: string;
  nameFont: string; nameEffect: string; nameColors: string[];
  badges: string[]; widgets: { id: string; type: string; enabled: boolean; position: number; content?: string }[];
  activityType: string; activityName: string;
  privacy: Record<string, string>;
  avatarStorageId?: Id<"_storage">; bannerStorageId?: Id<"_storage">;
};

export default function ProfileEditor({ onClose }: { onClose: () => void }) {
  const me = useQuery(api.profiles.myProfile, {});
  const appearance = useQuery(api.profiles.getAppearance, {});
  const save = useMutation(api.profiles.updateCustomization);
  const generateUploadUrl = useMutation(api.uploads.generateUploadUrl);

  const [tab, setTab] = useState<"profile" | "cosmetics" | "widgets" | "privacy">("profile");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [bannerPreview, setBannerPreview] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const avatarInput = useRef<HTMLInputElement>(null);
  const bannerInput = useRef<HTMLInputElement>(null);

  // Seed the draft from the saved profile once loaded.
  useEffect(() => {
    if (!me || draft) return;
    setDraft({
      displayName: me.displayName,
      bio: me.bio,
      pronouns: me.pronouns,
      customStatus: me.customStatus,
      // Collections normalized so a malformed record can never crash the editor.
      interests: toSafeArray<string>(me.interests, { label: "Profile interests", source: "api.profiles.myProfile" }).join(", "),
      socialLinks: toSafeArray<NonNullable<typeof me.socialLinks>[number]>(me.socialLinks, { label: "Profile social links", source: "api.profiles.myProfile" }),
      theme: me.theme,
      decorationId: me.decorationId ?? "",
      frameId: me.frameId ?? "frame_none",
      effectId: me.effectId ?? "effect_none",
      nameplateId: me.nameplateId ?? "plate_none",
      nameFont: me.nameFont,
      nameEffect: me.nameEffect,
      nameColors: toSafeArray<string>(me.nameColors, { label: "Profile name colors", source: "api.profiles.myProfile" }).length ? me.nameColors : ["#ffffff"],
      badges: toSafeArray<string>(me.badges, { label: "Profile badges", source: "api.profiles.myProfile" }),
      widgets: toSafeArray<NonNullable<typeof me.widgets>[number]>(me.widgets, { label: "Profile widgets", source: "api.profiles.myProfile" }),
      activityType: me.activity?.type ?? "playing",
      activityName: me.activity?.name ?? "",
      privacy: { ...me.privacy },
    });
  }, [me, draft]);

  const patch = (p: Partial<Draft>) => { setDraft((d) => (d ? { ...d, ...p } : d)); setDirty(true); };

  // Warn before losing unsaved edits.
  useEffect(() => {
    function handler(e: BeforeUnloadEvent) { if (dirty) { e.preventDefault(); e.returnValue = ""; } }
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  function requestClose() {
    if (dirty && !window.confirm("You have unsaved changes. Discard them?")) return;
    onClose();
  }

  async function upload(file: File, kind: "avatar" | "banner") {
    if (!file.type.startsWith("image/")) { toast.error("Choose a PNG, JPG, WebP, or GIF image."); return; }
    if (file.size > MAX_IMAGE) { toast.error("Images must be 5 MB or smaller."); return; }
    setUploadPct(0);
    try {
      const url = await generateUploadUrl({});
      const { storageId } = await new Promise<{ storageId: Id<"_storage"> }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", url);
        xhr.setRequestHeader("Content-Type", file.type);
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) setUploadPct(Math.round((e.loaded / e.total) * 100)); };
        xhr.onload = () => {
          if (xhr.status < 200 || xhr.status >= 300) { reject(new Error("Upload failed.")); return; }
          try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error("Upload failed.")); }
        };
        xhr.onerror = () => reject(new Error("Upload failed."));
        xhr.send(file);
      });
      if (kind === "avatar") { patch({ avatarStorageId: storageId }); setAvatarPreview(URL.createObjectURL(file)); }
      else { patch({ bannerStorageId: storageId }); setBannerPreview(URL.createObjectURL(file)); }
      toast.success(`${kind === "avatar" ? "Avatar" : "Banner"} ready — save to apply.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed.");
    } finally { setUploadPct(null); }
  }

  async function doSave() {
    if (!draft) return;
    setBusy(true);
    try {
      await save({
        displayName: draft.displayName,
        bio: draft.bio,
        pronouns: draft.pronouns,
        customStatus: draft.customStatus,
        interests: draft.interests.split(",").map((s) => s.trim()).filter(Boolean),
        socialLinks: draft.socialLinks,
        theme: draft.theme,
        decorationId: draft.decorationId,
        frameId: draft.frameId,
        effectId: draft.effectId,
        nameplateId: draft.nameplateId,
        nameFont: draft.nameFont,
        nameEffect: draft.nameEffect,
        nameColors: draft.nameColors,
        badges: draft.badges,
        widgets: draft.widgets,
        activityName: draft.activityName,
        activityType: draft.activityType,
        ...(draft.avatarStorageId ? { avatarStorageId: draft.avatarStorageId } : {}),
        ...(draft.bannerStorageId ? { bannerStorageId: draft.bannerStorageId } : {}),
        privacy: draft.privacy as never,
      });
      setDirty(false);
      toast.success("Profile saved.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save your profile.");
    } finally { setBusy(false); }
  }

  const themeColors = useMemo(() => THEMES.find((t) => t.id === draft?.theme)?.colors, [draft?.theme]);

  if (!me || !draft) {
    return <div className="fc-settings"><div className="fc-settings-content"><p className="fc-muted">Loading your profile…</p></div></div>;
  }

  return (
    <div className="fc-settings" role="dialog" aria-label="Profile editor">
      <header className="fc-settings-head">
        <h2>Edit profile</h2>
        <div className="fc-editor-head-actions">
          {dirty && <span className="fc-unsaved">Unsaved changes</span>}
          <Button size="sm" variant="ghost" onClick={() => { setDraft(null); setAvatarPreview(null); setBannerPreview(null); setDirty(false); toast.success("Reset to saved profile."); }}>
            <RotateCcw className="mr-1 h-4 w-4" /> Reset
          </Button>
          <Button size="sm" onClick={doSave} disabled={busy || !dirty}>
            <Save className="mr-1 h-4 w-4" /> {busy ? "Saving…" : "Save changes"}
          </Button>
          <button aria-label="Close editor" onClick={requestClose}><X size={18} /></button>
        </div>
      </header>

      <div className="fc-settings-body">
        <nav className="fc-settings-tabs" aria-label="Editor sections">
          {(["profile", "cosmetics", "widgets", "privacy"] as const).map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>

        <div className="fc-settings-content">
          {/* ---------- LIVE PREVIEW ---------- */}
          <div className="pf-preview" style={{ background: themeColors?.background }}>
            <div className="pf-preview-banner" style={{ background: themeColors ? `linear-gradient(135deg, ${themeColors.primary}, ${themeColors.background})` : undefined }}>
              {bannerPreview && <img src={bannerPreview} alt="" />}
              <ProfileEffect effectId={draft.effectId} reducedMotion={appearance?.reducedMotion} density={12} />
            </div>
            <div className="pf-preview-body">
              <ProfileAvatar
                name={draft.displayName}
                url={avatarPreview ?? me.avatarUrl}
                presence="online"
                frameId={draft.frameId}
                decorationId={draft.decorationId}
                reducedMotion={appearance?.reducedMotion}
                size={72}
              />
              <div>
                <h3 className="pf-name" style={nameStyle(draft.nameFont, draft.nameEffect, draft.nameColors)}>
                  <span className="pf-plate" style={plateStyle(draft.nameplateId)}>{draft.displayName || "Your name"}</span>
                </h3>
                <p className="pf-handle">@{me.username}</p>
                {draft.customStatus && <p className="pf-status">{draft.customStatus}</p>}
              </div>
            </div>
            <p className="pf-preview-note">Live preview — this is how others will see you.</p>
          </div>

          {tab === "profile" && (
            <section className="fc-settings-section">
              <h3><ImagePlus size={16} /> Profile picture</h3>
              <div className="fc-icon-row">
                <ProfileAvatar name={draft.displayName} url={avatarPreview ?? me.avatarUrl} frameId={draft.frameId} decorationId={draft.decorationId} reducedMotion={appearance?.reducedMotion} size={72} />
                <div className="fc-icon-actions">
                  <input ref={avatarInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f, "avatar"); e.target.value = ""; }} />
                  <Button size="sm" variant="outline" onClick={() => avatarInput.current?.click()} disabled={uploadPct !== null}>
                    {uploadPct !== null ? `Uploading… ${uploadPct}%` : "Upload avatar"}
                  </Button>
                  {avatarPreview && <Button size="sm" variant="ghost" onClick={() => { setAvatarPreview(null); toast.info("Preview reset. Save to keep the previous avatar."); }}>Reset</Button>}
                </div>
              </div>
              <p className="fc-muted">PNG, JPG, WebP or GIF, up to 5 MB. Animated GIFs are supported where your browser renders them.</p>

              <h3>Banner</h3>
              <div className="fc-icon-row">
                <span className="fc-banner-thumb" style={{ background: themeColors?.primary }}>{bannerPreview && <img src={bannerPreview} alt="" />}</span>
                <div className="fc-icon-actions">
                  <input ref={bannerInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f, "banner"); e.target.value = ""; }} />
                  <Button size="sm" variant="outline" onClick={() => bannerInput.current?.click()} disabled={uploadPct !== null}>Upload banner</Button>
                  {bannerPreview && <Button size="sm" variant="ghost" onClick={() => setBannerPreview(null)}><Trash2 className="mr-1 h-4 w-4" /> Remove</Button>}
                </div>
              </div>

              <label>Display name
                <Input value={draft.displayName} maxLength={40} onChange={(e) => patch({ displayName: e.target.value })} />
              </label>
              <label>Pronouns (optional)
                <Input value={draft.pronouns} maxLength={40} onChange={(e) => patch({ pronouns: e.target.value })} placeholder="she/her, they/them…" />
              </label>
              <label>About me <span className="fc-counter">{draft.bio.length}/600</span>
                <textarea className="fc-textarea" value={draft.bio} maxLength={600} rows={5} onChange={(e) => patch({ bio: e.target.value })} placeholder="Tell people about yourself. Line breaks are preserved." />
              </label>
              <label>Custom status
                <Input value={draft.customStatus} maxLength={120} onChange={(e) => patch({ customStatus: e.target.value })} placeholder="🎮 Playing a game" />
              </label>
              <label>Activity type
                <select className="fc-select" value={draft.activityType} onChange={(e) => patch({ activityType: e.target.value })}>
                  <option value="playing">Playing</option>
                  <option value="listening">Listening to</option>
                  <option value="watching">Watching</option>
                  <option value="streaming">Streaming</option>
                  <option value="custom">Custom</option>
                </select>
              </label>
              <label>Activity name
                <Input value={draft.activityName} maxLength={80} onChange={(e) => patch({ activityName: e.target.value })} placeholder="Freecord" />
              </label>
              <label>Interests (comma separated)
                <Input value={draft.interests} onChange={(e) => patch({ interests: e.target.value })} placeholder="art, gaming, music" />
              </label>

              <h3>Social links</h3>
              {draft.socialLinks.map((l, i) => (
                <div className="fc-link-row" key={i}>
                  <Input value={l.label} placeholder="Label" onChange={(e) => {
                    const next = [...draft.socialLinks]; next[i] = { ...next[i], label: e.target.value }; patch({ socialLinks: next });
                  }} />
                  <Input value={l.url} placeholder="https://…" onChange={(e) => {
                    const next = [...draft.socialLinks]; next[i] = { ...next[i], url: e.target.value }; patch({ socialLinks: next });
                  }} />
                  <Button size="sm" variant="ghost" aria-label="Remove link" onClick={() => patch({ socialLinks: draft.socialLinks.filter((_, x) => x !== i) })}><X className="h-4 w-4" /></Button>
                </div>
              ))}
              {draft.socialLinks.length < 8 && (
                <Button size="sm" variant="outline" onClick={() => patch({ socialLinks: [...draft.socialLinks, { label: "", url: "" }] })}>Add link</Button>
              )}
            </section>
          )}

          {tab === "cosmetics" && (
            <section className="fc-settings-section">
              <h3>Profile theme</h3>
              <div className="pf-swatch-row">
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    className={`pf-swatch ${draft.theme === t.id ? "active" : ""}`}
                    onClick={() => patch({ theme: t.id })}
                    title={t.description}
                    style={{ background: `linear-gradient(135deg, ${t.colors!.primary}, ${t.colors!.background})` }}
                  >
                    <span>{t.name}</span>
                  </button>
                ))}
              </div>

              <h3>Avatar decoration</h3>
              <div className="pf-chip-row">
                <button className={`pf-chip ${!draft.decorationId ? "active" : ""}`} onClick={() => patch({ decorationId: "" })}>None</button>
                {DECORATIONS.map((d) => (
                  <button key={d.id} className={`pf-chip ${draft.decorationId === d.id ? "active" : ""}`} onClick={() => patch({ decorationId: d.id })} title={d.description}>
                    <span aria-hidden="true">{d.glyph}</span> {d.name}
                  </button>
                ))}
              </div>

              <h3>Profile frame</h3>
              <div className="pf-chip-row">
                {FRAMES.map((f) => (
                  <button key={f.id} className={`pf-chip ${draft.frameId === f.id ? "active" : ""}`} onClick={() => patch({ frameId: f.id })} title={f.description}>
                    {f.background ? <span className="pf-chip-dot" style={{ background: f.background }} /> : null} {f.name}
                  </button>
                ))}
              </div>

              <h3>Profile effect</h3>
              <div className="pf-chip-row">
                {EFFECTS.map((e) => (
                  <button key={e.id} className={`pf-chip ${draft.effectId === e.id ? "active" : ""}`} onClick={() => patch({ effectId: e.id })} title={e.description}>
                    {e.glyph ? <span aria-hidden="true">{e.glyph}</span> : null} {e.name}
                  </button>
                ))}
              </div>
              {appearance?.reducedMotion && <p className="fc-muted">Effects are disabled because reduced motion is on in Appearance settings.</p>}

              <h3>Nameplate</h3>
              <div className="pf-chip-row">
                {NAMEPLATES.map((p) => (
                  <button key={p.id} className={`pf-chip ${draft.nameplateId === p.id ? "active" : ""}`} onClick={() => patch({ nameplateId: p.id })}>
                    <span className="pf-chip-plate" style={plateStyle(p.id)} /> {p.name}
                  </button>
                ))}
              </div>

              <h3>Display name style</h3>
              <label>Font
                <select className="fc-select" value={draft.nameFont} onChange={(e) => patch({ nameFont: e.target.value })}>
                  {NAME_FONTS.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </label>
              <label>Effect
                <select className="fc-select" value={draft.nameEffect} onChange={(e) => patch({ nameEffect: e.target.value })}>
                  {NAME_EFFECTS.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </label>
              <div className="fc-color-row">
                <label>Colour 1
                  <input type="color" value={draft.nameColors[0] ?? "#ffffff"} onChange={(e) => patch({ nameColors: [e.target.value, draft.nameColors[1] ?? e.target.value] })} />
                </label>
                <label>Colour 2 (gradient)
                  <input type="color" value={draft.nameColors[1] ?? draft.nameColors[0] ?? "#ffffff"} onChange={(e) => patch({ nameColors: [draft.nameColors[0] ?? "#ffffff", e.target.value] })} />
                </label>
              </div>

              <h3>Badges</h3>
              <div className="pf-chip-row">
                {BADGES.map((b) => {
                  const on = draft.badges.includes(b.id);
                  return (
                    <button key={b.id} className={`pf-chip ${on ? "active" : ""}`} title={b.description} onClick={() => patch({ badges: on ? draft.badges.filter((x) => x !== b.id) : [...draft.badges, b.id] })}>
                      <span aria-hidden="true">{b.glyph}</span> {b.name}
                    </button>
                  );
                })}
              </div>
              <p className="fc-muted">Badges are cosmetic and never grant permissions.</p>
            </section>
          )}

          {tab === "widgets" && (
            <section className="fc-settings-section">
              <h3>Profile widgets</h3>
              <p className="fc-muted">Enable widgets and reorder them with the arrows. Order is saved to your profile.</p>
              {WIDGET_TYPES.map((w) => {
                const existing = draft.widgets.find((x) => x.type === w.id);
                const enabled = existing?.enabled ?? false;
                return (
                  <div className="fc-widget-row" key={w.id}>
                    <label className="fc-checkbox-row">
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(e) => {
                          if (e.target.checked) {
                            patch({ widgets: [...draft.widgets.filter((x) => x.type !== w.id), { id: `${w.id}_${Date.now()}`, type: w.id, enabled: true, position: draft.widgets.length }] });
                          } else {
                            patch({ widgets: draft.widgets.map((x) => (x.type === w.id ? { ...x, enabled: false } : x)) });
                          }
                        }}
                      />
                      {w.name}
                    </label>
                    {existing?.enabled && (
                      <div className="fc-widget-order">
                        <button aria-label="Move up" onClick={() => {
                          const sorted = [...draft.widgets].sort((a, b) => a.position - b.position);
                          const idx = sorted.findIndex((x) => x.type === w.id);
                          if (idx <= 0) return;
                          [sorted[idx - 1], sorted[idx]] = [sorted[idx], sorted[idx - 1]];
                          patch({ widgets: sorted.map((x, i) => ({ ...x, position: i })) });
                        }}>↑</button>
                        <button aria-label="Move down" onClick={() => {
                          const sorted = [...draft.widgets].sort((a, b) => a.position - b.position);
                          const idx = sorted.findIndex((x) => x.type === w.id);
                          if (idx < 0 || idx >= sorted.length - 1) return;
                          [sorted[idx + 1], sorted[idx]] = [sorted[idx], sorted[idx + 1]];
                          patch({ widgets: sorted.map((x, i) => ({ ...x, position: i })) });
                        }}>↓</button>
                      </div>
                    )}
                    {existing?.enabled && w.id === "custom" && (
                      <Input
                        value={existing.content ?? ""}
                        maxLength={400}
                        placeholder="Custom text for this widget"
                        onChange={(e) => patch({ widgets: draft.widgets.map((x) => (x.type === "custom" ? { ...x, content: e.target.value } : x)) })}
                      />
                    )}
                  </div>
                );
              })}
            </section>
          )}

          {tab === "privacy" && (
            <section className="fc-settings-section">
              <h3>Profile privacy</h3>
              <p className="fc-muted">Choose who can see each part of your profile. Avatar, username and basic account info stay visible.</p>
              {(["bio", "pronouns", "badges", "activity", "socialLinks", "widgets", "friendsList", "mutuals", "customStatus"] as const).map((field) => (
                <label className="fc-select-row" key={field}>                    {field === "friendsList" ? "Followers & following lists" : field.charAt(0).toUpperCase() + field.slice(1).replace(/([A-Z])/g, " $1")}
                  <select
                    className="fc-select"
                    value={draft.privacy[field] ?? "everyone"}
                    onChange={(e) => patch({ privacy: { ...draft.privacy, [field]: e.target.value } })}
                  >
                    {VISIBILITY.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
                  </select>
                </label>
              ))}
              <p className="fc-muted">These rules are enforced on the server — hidden fields are never sent to other users.</p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
