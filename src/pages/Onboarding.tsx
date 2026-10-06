import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { toSafeArray } from "@/lib/collection";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FreecordMark } from "./Landing";
import { ArrowRight, Check, Compass, Palette, Search, Shield, Sparkles, Users } from "lucide-react";
import { toast } from "sonner";

const COLORS = ["violet", "indigo", "sky", "emerald", "amber", "rose"];
const AVATAR_BG: Record<string, string> = {
  violet: "#7c5cf6", indigo: "#6366f1", sky: "#0ea5e9",
  emerald: "#10b981", amber: "#f59e0b", rose: "#f43f5e",
};

export default function Onboarding() {
  const { isLoading, isAuthenticated, user } = useAuth();
  const navigate = useNavigate();
  const me = useQuery(api.users.me, {});
  const updateProfile = useMutation(api.users.updateProfile);
  const updateSettings = useMutation(api.users.updateSettings);
  const discover = useQuery(api.communities.discover, {});
  const joinCommunity = useMutation(api.communities.join);
  const searchUsers = useQuery(api.users.searchUsers, { q: "" });
  // Normalized collections so a malformed payload can never crash onboarding.
  const discoverList = toSafeArray<NonNullable<typeof discover>[number]>(discover, { label: "Discovered communities", source: "api.communities.discover" });
  const searchUserList = toSafeArray<NonNullable<typeof searchUsers>[number]>(searchUsers, { label: "People search results", source: "api.users.searchUsers" });

  const [step, setStep] = useState(0);
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [color, setColor] = useState("violet");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!isLoading && !isAuthenticated) navigate("/auth?returnTo=/onboarding", { replace: true });
  }, [isLoading, isAuthenticated, navigate]);

  useEffect(() => {
    if (me?.profile?.displayName && !displayName) setDisplayName(me.profile.displayName);
  }, [me, displayName]);

  const steps = ["Profile", "Privacy", "Communities", "Done"];

  async function finish() {
    setBusy(true);
    try {
      await updateProfile({ displayName: displayName.trim() || "Freecord member", bio, avatarColor: color });
      toast.success("Welcome to Freecord!");
      navigate("/dashboard");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save your profile.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-freecord min-h-screen flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-2xl">
        <div className="mb-6 flex items-center justify-between">
          <FreecordMark />
          <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => navigate("/dashboard")}>
            Skip for now
          </button>
        </div>

        <div className="mb-6 flex gap-2">
          {steps.map((s, i) => (
            <div key={s} className={`h-1 flex-1 rounded-full ${i <= step ? "bg-primary" : "bg-white/10"}`} />
          ))}
        </div>

        <div className="rounded-2xl border border-white/8 bg-[#15151d] p-7">
          {step === 0 && (
            <div className="space-y-5">
              <div className="flex items-center gap-2 text-primary"><Sparkles className="h-5 w-5" /><span className="text-xs font-semibold uppercase tracking-wider">Step 1 of 4</span></div>
              <h1 className="text-2xl font-semibold">Make it yours.</h1>
              <p className="text-sm text-muted-foreground">Pick a display name and an avatar color. You can change these anytime in Settings.</p>
              <div className="flex items-center gap-4">
                <div className="grid h-16 w-16 place-items-center rounded-full text-lg font-semibold text-white" style={{ background: AVATAR_BG[color] }}>
                  {(displayName || user?.name || "F").slice(0, 2).toUpperCase()}
                </div>
                <div className="flex gap-2">
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      aria-label={`Avatar color ${c}`}
                      onClick={() => setColor(c)}
                      className={`h-8 w-8 rounded-full ${color === c ? "ring-2 ring-white/70 ring-offset-2 ring-offset-[#15151d]" : ""}`}
                      style={{ background: AVATAR_BG[c] }}
                    />
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="dn">Display name</label>
                <Input id="dn" value={displayName} maxLength={40} onChange={(e) => setDisplayName(e.target.value)} placeholder="Your name" />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="bio">Bio (optional)</label>
                <Input id="bio" value={bio} maxLength={200} onChange={(e) => setBio(e.target.value)} placeholder="A little about you" />
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-5">
              <div className="flex items-center gap-2 text-primary"><Shield className="h-5 w-5" /><span className="text-xs font-semibold uppercase tracking-wider">Step 2 of 4</span></div>
              <h1 className="text-2xl font-semibold">You're in control.</h1>
              <p className="text-sm text-muted-foreground">These defaults keep things friendly. Change them anytime in Privacy settings.</p>
              {[
                { key: "searchable", label: "Appear in search", hint: "Let people find you by username or display name." },
                { key: "publicProfile", label: "Public profile", hint: "Allow anyone to view your profile." },
                { key: "presenceVisible", label: "Show my presence", hint: "Display your online status to others." },
                { key: "readReceipts", label: "Read receipts", hint: "Let others see when you've read a message." },
              ].map((row) => (
                <label key={row.key} className="flex items-start justify-between gap-4 rounded-lg border border-white/8 p-3">
                  <span>
                    <span className="block text-sm">{row.label}</span>
                    <span className="block text-xs text-muted-foreground">{row.hint}</span>
                  </span>
                  <input
                    type="checkbox"
                    defaultChecked
                    className="mt-1 h-4 w-4 accent-[#7c5cf6]"
                    onChange={(e) => updateSettings({ [row.key]: e.target.checked } as never)}
                  />
                </label>
              ))}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-5">
              <div className="flex items-center gap-2 text-primary"><Compass className="h-5 w-5" /><span className="text-xs font-semibold uppercase tracking-wider">Step 3 of 4</span></div>
              <h1 className="text-2xl font-semibold">Find your people.</h1>
              <p className="text-sm text-muted-foreground">Join a public community to get started. You can create your own later.</p>
              <div className="relative">
                <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                <Input className="pl-9" placeholder="Search communities" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
              <div className="max-h-56 space-y-2 overflow-y-auto">
                {discoverList
                  .filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
                  .slice(0, 8)
                  .map((c) => (
                    <div key={c.serverId} className="flex items-center justify-between gap-3 rounded-lg border border-white/8 p-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{c.name}</p>
                        <p className="truncate text-xs text-muted-foreground">{c.description || "No description"} · {c.memberCount} members</p>
                      </div>
                      <Button size="sm" variant="outline" onClick={async () => {
                        try { await joinCommunity({ serverId: c.serverId }); toast.success(`Joined ${c.name}`); }
                        catch (e) { toast.error(e instanceof Error ? e.message : "Could not join."); }
                      }}>Join</Button>
                    </div>
                  ))}
                {discoverList.length === 0 && (
                  <p className="py-6 text-center text-sm text-muted-foreground">No public communities yet. Create your own!</p>
                )}
              </div>
              <p className="flex items-center gap-2 text-xs text-muted-foreground"><Users className="h-3.5 w-3.5" /> {searchUserList.length} people are already on Freecord.</p>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-5">
              <div className="flex items-center gap-2 text-primary"><Check className="h-5 w-5" /><span className="text-xs font-semibold uppercase tracking-wider">Step 4 of 4</span></div>
              <h1 className="text-2xl font-semibold">You're all set.</h1>
              <p className="text-sm text-muted-foreground">
                Your Freecord account is ready. You signed up without an email — you can add one later
                in Settings to enable account recovery.
              </p>
              <div className="flex items-center gap-3 rounded-lg border border-white/8 p-3 text-sm">
                <Palette className="h-4 w-4 text-primary" />
                <span className="text-muted-foreground">Tip: press the search icon in the sidebar to find people, communities, and messages.</span>
              </div>
            </div>
          )}

          <div className="mt-7 flex items-center justify-between">
            <Button variant="ghost" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>Back</Button>
            {step < 3 ? (
              <Button onClick={() => setStep((s) => s + 1)}>Continue <ArrowRight className="ml-2 h-4 w-4" /></Button>
            ) : (
              <Button onClick={finish} disabled={busy}>{busy ? "Saving…" : "Enter Freecord"} <ArrowRight className="ml-2 h-4 w-4" /></Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
