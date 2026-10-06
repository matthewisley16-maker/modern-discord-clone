import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Avatar } from "./ui";
import { toSafeArray } from "@/lib/collection";
import { toast } from "sonner";
import { Check, Search, Users, X } from "lucide-react";

/**
 * "New Message" composer.
 *
 * Two clearly distinct modes:
 *  - Send separately (Batch): one message is delivered to each recipient as its
 *    own private 1:1 conversation. Recipients can never see the other recipients.
 *  - Create group chat: everyone shares one conversation and can see each other.
 */
export default function NewMessageDialog({
  open,
  onClose,
  onOpenConversation,
}: {
  open: boolean;
  onClose: () => void;
  onOpenConversation: (id: Id<"dmConversations">) => void;
}) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"separate" | "group">("separate");
  const [selected, setSelected] = useState<{ userId: string; displayName: string; username: string; avatarUrl: string | null; decorationId: string | null }[]>([]);
  const [groupName, setGroupName] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const results = useQuery(api.users.searchUsers, { q: query });
  const sendBatch = useMutation(api.dms.sendBatch);
  const createGroup = useMutation(api.dms.createGroup);

  const resultList = useMemo(
    () => toSafeArray<NonNullable<typeof results>[number]>(results, { label: "Recipient search results", source: "api.users.searchUsers" }),
    [results],
  );
  const selectedIds = useMemo(() => new Set(selected.map((s) => s.userId)), [selected]);
  const candidates = resultList.filter((r) => !selectedIds.has(r.userId));

  const reset = () => {
    setQuery(""); setSelected([]); setBody(""); setGroupName(""); setMode("separate"); setConfirming(false);
  };

  const close = () => { reset(); onClose(); };

  const add = (r: { userId: string; displayName: string; username: string; avatarUrl: string | null; decorationId: string | null }) => {
    setSelected((prev) => [...prev, r]);
    setQuery("");
  };

  const canSend = mode === "group" ? selected.length >= 1 && groupName.trim().length > 0 : selected.length >= 1 && body.trim().length > 0;

  async function doSend() {
    setBusy(true);
    try {
      if (mode === "group") {
        const id = await createGroup({ name: groupName.trim(), memberIds: selected.map((s) => s.userId as Id<"users">) });
        toast.success("Group chat created.");
        onOpenConversation(id);
        close();
      } else {
        const res = await sendBatch({ userIds: selected.map((s) => s.userId as Id<"users">), body: body.trim() });
        toast.success(
          res.sent === 1 ? "Message sent privately." : `Sent separately to ${res.sent} people.`,
        );
        if (res.skipped.length > 0) toast.message(`${res.skipped.length} recipient(s) couldn't be messaged.`);
        close();
      }
    } catch (e) {
      const msg = (e as { data?: string; message?: string })?.data || (e as { message?: string })?.message || "Could not send.";
      toast.error(String(msg).replace(/^\[.*?\]\s*/, "").split("\n")[0]);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New message</DialogTitle>
          <DialogDescription>
            {mode === "separate"
              ? "Each person gets their own private conversation. Nobody can see who else received it."
              : "Everyone shares one conversation and can see each other's messages."}
          </DialogDescription>
        </DialogHeader>

        {/* Mode switch: deliberately distinct actions. */}
        <div className="flex gap-2">
          <button
            type="button"
            className={`flex-1 rounded-lg border px-3 py-2 text-left text-xs ${mode === "separate" ? "border-violet-400/50 bg-violet-500/10" : "border-white/10"}`}
            onClick={() => setMode("separate")}
          >
            <strong className="block text-sm">Send separately</strong>
            Multiple private 1:1 chats (batch)
          </button>
          <button
            type="button"
            className={`flex-1 rounded-lg border px-3 py-2 text-left text-xs ${mode === "group" ? "border-violet-400/50 bg-violet-500/10" : "border-white/10"}`}
            onClick={() => setMode("group")}
          >
            <strong className="block text-sm">Create group chat</strong>
            One shared conversation
          </button>
        </div>

        {/* Selected recipients */}
        {selected.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {selected.map((s) => (
              <span key={s.userId} className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/5 px-2 py-1 text-xs">
                <Avatar name={s.displayName} size={18} url={s.avatarUrl} decorationId={s.decorationId} />
                {s.displayName}
                <button aria-label={`Remove ${s.displayName}`} onClick={() => setSelected((prev) => prev.filter((x) => x.userId !== s.userId))}><X size={12} /></button>
              </span>
            ))}
            <span className="self-center text-xs text-muted-foreground">{selected.length} selected</span>
          </div>
        )}

        {/* Recipient search */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search usernames to add" className="pl-8" />
        </div>
        {query.trim() && (
          <div className="max-h-44 overflow-y-auto rounded-lg border border-white/10">
            {candidates.length === 0 && <p className="p-3 text-xs text-muted-foreground">No one matches “{query}”.</p>}
            {candidates.map((r) => (
              <button key={r.userId} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/5" onClick={() => add(r)}>
                <Avatar name={r.displayName} size={24} url={r.avatarUrl} decorationId={r.decorationId} />
                <span className="flex-1 truncate">{r.displayName} <span className="text-muted-foreground">@{r.username}</span></span>
                <Check size={14} />
              </button>
            ))}
          </div>
        )}

        {mode === "group" && (
          <Input value={groupName} onChange={(e) => setGroupName(e.target.value)} maxLength={50} placeholder="Group name" />
        )}

        {mode === "separate" && (
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            maxLength={4000}
            placeholder="Write your message…"
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring"
          />
        )}

        {confirming ? (
          <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-sm">
            <p className="font-medium">Send separately to {selected.length} people?</p>
            <p className="mt-1 text-xs text-muted-foreground">
              This creates {selected.length} private conversations. Recipients will not see who else received it.
            </p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" disabled={busy} onClick={doSend}>Yes, send separately</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <DialogFooter>
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button
              disabled={busy || !canSend}
              onClick={() => { if (mode === "separate" && selected.length > 1) setConfirming(true); else doSend(); }}
            >
              <Users className="mr-2 size-4" />
              {mode === "group"
                ? `Create group (${selected.length})`
                : selected.length > 1 ? `Send separately to ${selected.length} people` : "Send"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
