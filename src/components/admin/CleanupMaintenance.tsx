import { useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { FeatureBoundary } from "@/components/ui/feature-boundary";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  History,
  Loader2,
  ShieldAlert,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  CLEANUP_HISTORY_LIMIT,
  categoriesProblem,
  formatBytes,
  formatCount,
  formatMoment,
  fromLocalPicker,
  includesOwnerOnlyCategory,
  isSiteWide,
  phraseMatches,
  progressPercent,
  rangeProblem,
  requiredPhrase,
  scopeProblem,
  timeZoneLabel,
  toLocalPicker,
  type CleanupScope,
  type CleanupScopeKind,
  type MessageRange,
  type RangeRequest,
} from "@/lib/cleanup";

/**
 * Admin Panel → Cleanup & Maintenance.
 *
 * Two tools, wired to the real database:
 *
 *   1. Message Cleanup — deletes messages by WHEN they were sent, optionally
 *      limited to one community, channel or conversation.
 *   2. General System Cleanup — removes data that is disposable by rule (expired,
 *      or referenced by nothing).
 *
 * This file decides what an administrator SEES. It never decides what is allowed:
 * every count comes from the server (`previewMessages` / `previewGeneral`), and
 * every delete re-checks the administrator role, the scope, the date range and —
 * for a site-wide deletion — the typed confirmation phrase on the backend. The
 * shared rule module (`@/lib/cleanup`) is the same one the server imports, so the
 * warning, the phrase and the label shown here cannot drift from what the backend
 * enforces.
 */

type Permissions = NonNullable<FunctionReturnType<typeof api.cleanup.permissions>>;
type ScopeList = NonNullable<FunctionReturnType<typeof api.cleanup.scopes>>;
type MessagePreview = FunctionReturnType<typeof api.cleanup.previewMessages>;
type GeneralPreview = FunctionReturnType<typeof api.cleanup.previewGeneral>;
type JobView = NonNullable<FunctionReturnType<typeof api.cleanup.job>>;
type HistoryRow = FunctionReturnType<typeof api.cleanup.history>[number];
type CategoryRow = GeneralPreview["categories"][number];

/**
 * What a running job is expected to touch, so the progress bar has a denominator.
 * `approximate` marks a lower bound (the server counted a capped scan), which is
 * why the bar never claims to be finished while the job is still running.
 */
type Expectation = { total: number; approximate: boolean };

const DAY_MS = 86_400_000;

/** Reads a ConvexError's user-safe message (same pattern as the rest of the panel). */
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

/** A destructive-action warning strip used by both tools. */
function DangerNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.07] p-3 text-xs text-muted-foreground">
      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
      <span>{children}</span>
    </p>
  );
}

/** One neutral informational strip (time zone, safety rules, recovery). */
function InfoNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-white/10 bg-white/[0.02] p-3 text-xs text-muted-foreground">
      <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span>{children}</span>
    </p>
  );
}

/**
 * Message Cleanup: scope + when + preview + confirmed deletion.
 *
 * The Delete button stays disabled until the server has been asked for a preview,
 * so an administrator always sees the number of messages a confirmation is about
 * before the confirmation exists.
 */
function MessageCleanup({
  permissions,
  onStarted,
}: {
  permissions: Permissions;
  /** Hands the new job to the shell so its progress can be watched. */
  onStarted: (jobId: Id<"cleanupJobs">, expectation: Expectation) => void;
}) {
  const [scopeKind, setScopeKind] = useState<CleanupScopeKind>("all");
  const [scopeId, setScopeId] = useState("");
  const [rangeKind, setRangeKind] = useState<"all" | "before" | "between">("before");
  const [beforePicker, setBeforePicker] = useState(() => toLocalPicker(Date.now()));
  const [fromPicker, setFromPicker] = useState(() => toLocalPicker(Date.now() - 30 * DAY_MS));
  const [toPicker, setToPicker] = useState(() => toLocalPicker(Date.now()));

  const scopes = useQuery(
    api.cleanup.scopes,
    // The DM list changes constantly, so it is only read when a conversation is
    // actually being chosen — otherwise this would re-run on every new message.
    { includeConversations: scopeKind === "conversation" },
  ) as ScopeList | undefined;

  const runPreview = useAction(api.cleanup.previewMessages);
  const start = useMutation(api.cleanup.startMessageCleanup);

  // The preview is kept TOGETHER with the form values that produced it. Editing the
  // scope, the dates or the range simply stops it matching, so a stale number can
  // never sit next to the Delete button — no effect, no extra render.
  const [previewOf, setPreviewOf] = useState<{ key: string; preview: MessagePreview } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [starting, setStarting] = useState(false);

  /** The range the form currently describes (validated by the shared rules). */
  const rawRange: RangeRequest =
    rangeKind === "all"
      ? { kind: "all" }
      : rangeKind === "before"
        ? { kind: "before", before: fromLocalPicker(beforePicker) as number }
        : { kind: "between", from: fromLocalPicker(fromPicker) as number, to: fromLocalPicker(toPicker) as number };
  const rangeNotice = rangeProblem(rawRange);
  const scopeNotice = scopeKind === "all" ? null : scopeProblem({ kind: scopeKind, id: scopeId });

  /** The scope as the shared rules see it (the server resolves the real label). */
  const scopeForRules: CleanupScope =
    scopeKind === "all" ? { kind: "all" } : { kind: scopeKind, id: scopeId, label: "" };

  /** The form values every shown count belongs to. */
  const formKey = `${scopeKind}|${scopeId}|${rangeKind}|${beforePicker}|${fromPicker}|${toPicker}`;
  const preview = previewOf !== null && previewOf.key === formKey ? previewOf.preview : null;
  const previewMatchesForm = preview !== null;

  const timeZone = permissions.timeZone;
  const range: MessageRange | null = rangeNotice ? null : rawRange;
  const siteWide = range !== null && isSiteWide(scopeForRules, range);
  const phraseRequired = range !== null ? requiredPhrase(scopeForRules, range) : null;

  const communityOptions = scopes?.communities ?? [];
  const channelOptions = useMemo(
    () => (scopes?.channels ?? []).filter((c) => scopeKind !== "community" || c.communityId === scopeId),
    [scopes, scopeKind, scopeId],
  );
  const conversationOptions = scopes?.conversations ?? [];

  async function onPreview() {
    if (scopeNotice || rangeNotice || !range) {
      toast.error(scopeNotice ?? rangeNotice ?? "Choose what to clean up.");
      return;
    }
    setPreviewing(true);
    try {
      const result = await runPreview({
        scopeKind,
        scopeId: scopeKind === "all" ? undefined : scopeId,
        rangeKind: range.kind,
        ...(range.kind === "before" ? { before: range.before } : {}),
        ...(range.kind === "between" ? { from: range.from, to: range.to } : {}),
      });
      setPreviewOf({ key: formKey, preview: result });
      if (result.total === 0) {
        toast.message("Nothing matches", {
          description: "No messages in that scope were sent in the selected time range.",
        });
      }
    } catch (err) {
      toast.error(friendly(err, "Could not preview the affected messages."));
    } finally {
      setPreviewing(false);
    }
  }

  async function onDelete() {
    if (!preview || !range) return;
    setStarting(true);
    try {
      const result = await start({
        scopeKind,
        scopeId: scopeKind === "all" ? undefined : scopeId,
        rangeKind: range.kind,
        ...(range.kind === "before" ? { before: range.before } : {}),
        ...(range.kind === "between" ? { from: range.from, to: range.to } : {}),
        ...(phraseRequired ? { confirmPhrase: phrase } : {}),
      });
      setConfirming(false);
      setPhrase("");
      setPreviewOf(null);
      onStarted(result.jobId, { total: result.total, approximate: result.approximate });
      toast.success("Message cleanup started", {
        description: `${result.approximate ? "At least " : ""}${formatCount(result.total)} messages matched. Progress is shown below and in Cleanup history.`,
      });
    } catch (err) {
      toast.error(friendly(err, "Could not start the cleanup."));
    } finally {
      setStarting(false);
    }
  }

  const phraseOk = phraseMatches(phraseRequired, phrase);

  return (
    <Card className="border-white/10 bg-card/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Trash2 className="size-4 text-destructive" /> Message Cleanup
        </CardTitle>
        <CardDescription>
          Delete messages by when they were sent — across the whole site, or limited to one community, channel or
          conversation. Nothing is deleted until you preview it and confirm.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ---------------- Scope ---------------- */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">What to clean up</label>
            <Select
              value={scopeKind}
              onValueChange={(value) => {
                setScopeKind(value as CleanupScopeKind);
                setScopeId("");
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {permissions.canDeleteSiteWide ? (
                  <SelectItem value="all">All messages (site-wide)</SelectItem>
                ) : (
                  <SelectItem value="all" disabled>
                    All messages (site-wide) — Owner Admin only
                  </SelectItem>
                )}
                <SelectItem value="community">One community</SelectItem>
                <SelectItem value="channel">One channel</SelectItem>
                <SelectItem value="conversation">One direct conversation</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {scopeKind === "community" && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Community</label>
              <Select value={scopeId} onValueChange={setScopeId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a community" />
                </SelectTrigger>
                <SelectContent>
                  {communityOptions.length === 0 && (
                    <SelectItem value="__none" disabled>
                      No communities available
                    </SelectItem>
                  )}
                  {communityOptions.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {scopeKind === "channel" && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Channel</label>
              <Select value={scopeId} onValueChange={setScopeId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a channel" />
                </SelectTrigger>
                <SelectContent>
                  {channelOptions.length === 0 && (
                    <SelectItem value="__none" disabled>
                      No channels available
                    </SelectItem>
                  )}
                  {channelOptions.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {scopeKind === "conversation" && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Direct conversation</label>
              <Select value={scopeId} onValueChange={setScopeId}>
                <SelectTrigger>
                  <SelectValue placeholder={scopes ? "Choose a conversation" : "Loading…"} />
                </SelectTrigger>
                <SelectContent>
                  {conversationOptions.length === 0 && (
                    <SelectItem value="__none" disabled>
                      No conversations available
                    </SelectItem>
                  )}
                  {conversationOptions.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.isGroup ? `${c.label} (group)` : c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        {/* ---------------- When ---------------- */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Which messages</label>
            <Select value={rangeKind} onValueChange={(value) => setRangeKind(value as typeof rangeKind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Every message, any date</SelectItem>
                <SelectItem value="before">Sent before a date and time</SelectItem>
                <SelectItem value="between">Sent within a date range</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {rangeKind === "before" && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Delete messages sent before</label>
              <Input
                type="datetime-local"
                value={beforePicker}
                onChange={(e) => setBeforePicker(e.target.value)}
                className="w-full"
              />
            </div>
          )}

          {rangeKind === "between" && (
            <>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Start</label>
                <Input
                  type="datetime-local"
                  value={fromPicker}
                  onChange={(e) => setFromPicker(e.target.value)}
                  className="w-full"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">End (inclusive)</label>
                <Input
                  type="datetime-local"
                  value={toPicker}
                  onChange={(e) => setToPicker(e.target.value)}
                  className="w-full"
                />
              </div>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <Badge variant="outline" className="border-white/15">
            Time zone: {timeZoneLabel(timeZone)}
          </Badge>
          <span>
            {range
              ? `Interpreted in ${timeZone}: ${
                  range.kind === "all"
                    ? "every message, any date"
                    : range.kind === "before"
                      ? `sent before ${formatMoment(range.before, timeZone)}`
                      : `${formatMoment(range.from, timeZone)} → ${formatMoment(range.to, timeZone)}`
                }`
              : rangeNotice}
          </span>
        </div>

        {scopeNotice && <p className="text-xs text-destructive">{scopeNotice}</p>}
        {scopeKind === "all" && (
          <DangerNote>
            {permissions.canDeleteSiteWide
              ? "This scope covers every community, channel and direct conversation on Freecord. A site-wide deletion also requires typing a confirmation phrase."
              : permissions.siteWideNote}
          </DangerNote>
        )}

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={onPreview} disabled={previewing || Boolean(scopeNotice) || Boolean(rangeNotice)}>
            {previewing ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
            Preview affected messages
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              setPhrase("");
              setConfirming(true);
            }}
            disabled={!previewMatchesForm || (preview?.total ?? 0) === 0}
          >
            <Trash2 className="mr-1 size-4" /> Delete messages…
          </Button>
        </div>
        {!previewMatchesForm && (
          <p className="text-xs text-muted-foreground">
            Preview the affected messages first — the number of messages is shown before the Delete button becomes
            available.
          </p>
        )}

        {/* ---------------- Preview result ---------------- */}
        {previewMatchesForm && preview && (
          <div className="space-y-2 rounded-lg border border-white/10 bg-white/[0.02] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">
                {preview.approximate ? "At least " : ""}
                {formatCount(preview.total)} message{preview.total === 1 ? "" : "s"} will be deleted
              </span>
              {preview.approximate && (
                <Badge variant="outline" className="border-amber-400/40 text-amber-300">
                  Lower bound
                </Badge>
              )}
              {siteWide && (
                <Badge variant="destructive" className="gap-1">
                  <ShieldAlert className="size-3" /> Site-wide
                </Badge>
              )}
            </div>
            <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
              <span>Scope: {preview.scopeLabel}</span>
              <span>Range: {preview.rangeLabel}</span>
              <span>
                Channel messages: {formatCount(preview.channelMessages)} · Direct messages:{" "}
                {formatCount(preview.dmMessages)}
              </span>
              <span>
                Oldest: {preview.oldest ? formatMoment(preview.oldest, preview.timeZone) : "—"} · Newest:{" "}
                {preview.newest ? formatMoment(preview.newest, preview.timeZone) : "—"}
              </span>
            </div>
            {preview.approximate && (
              <p className="text-xs text-muted-foreground">
                This history is too large to count in one pass, so the figure is a lower bound. The cleanup itself
                processes every matching message, in batches.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Attached files are removed with their message only when no other message still uses them.
            </p>
          </div>
        )}
      </CardContent>

      {/* ---------------- Confirmation ---------------- */}
      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open) {
            setConfirming(false);
            setPhrase("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Are you sure you want to delete {formatCount(preview?.total ?? 0)} messages?
            </DialogTitle>
            <DialogDescription>
              {preview ? `${preview.scopeLabel} · ${preview.rangeLabel}` : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <p className="text-sm text-destructive">
              This action may not be reversible. The messages are removed for <strong>everyone</strong> — content,
              attachments and any stored file that no other message still uses. Audit records of this cleanup are kept.
            </p>
            {siteWide && (
              <>
                <DangerNote>
                  You are deleting messages across the <strong>entire site</strong>, not just one community or
                  conversation. Type the phrase below to confirm.
                </DangerNote>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">
                    Type <span className="font-mono text-destructive">{requiredPhrase(scopeForRules, range ?? { kind: "all" })}</span> to
                    confirm
                  </label>
                  <Input
                    value={phrase}
                    onChange={(e) => setPhrase(e.target.value)}
                    placeholder="DELETE ALL MESSAGES"
                    autoComplete="off"
                  />
                </div>
              </>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirming(false);
                setPhrase("");
              }}
            >
              Cancel
            </Button>
            <Button variant="destructive" disabled={starting || !phraseOk} onClick={onDelete}>
              {starting ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
              Delete messages
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/**
 * General System Cleanup: pick categories, preview them, then run.
 *
 * Every category card states what it may remove and why that is safe; the numbers
 * come from the read-only preview, and running is a second, explicit step.
 */
function GeneralCleanup({
  permissions,
  onStarted,
}: {
  permissions: Permissions;
  /** Hands the new job to the shell so its progress can be watched. */
  onStarted: (jobId: Id<"cleanupJobs">, expectation: Expectation) => void;
}) {
  const runPreview = useAction(api.cleanup.previewGeneral);
  const start = useMutation(api.cleanup.startGeneralCleanup);

  const allowed = useMemo(() => permissions.categories.filter((c) => c.allowed), [permissions]);
  const [chosenIds, setChosenIds] = useState<string[]>(() => allowed.map((c) => c.id));
  const [preview, setPreview] = useState<GeneralPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);

  // A selection that permissions no longer allow (the role may have been edited
  // elsewhere) is dropped as it is rendered, rather than in an effect.
  const allowedIds = useMemo(() => new Set(allowed.map((c) => c.id)), [allowed]);
  const selected = useMemo(() => chosenIds.filter((id) => allowedIds.has(id)), [chosenIds, allowedIds]);

  const chosen = preview?.categories.filter((c) => selected.includes(c.id)) ?? [];
  const totals = chosen.reduce(
    (acc, c) => ({ records: acc.records + c.records, bytes: acc.bytes + c.bytes }),
    { records: 0, bytes: 0 },
  );

  const byId = useMemo(() => new Map(preview?.categories.map((c) => [c.id, c]) ?? []), [preview]);

  function toggle(id: string, on: boolean) {
    setPreview(null);
    setChosenIds((current) => (on ? [...new Set([...current, id])] : current.filter((x) => x !== id)));
  }

  async function onPreview() {
    const problem = categoriesProblem(selected);
    if (problem) {
      toast.error(problem);
      return;
    }
    setPreviewing(true);
    try {
      const result = await runPreview({ categories: selected });
      setPreview(result);
      const records = result.categories.reduce((sum, c) => sum + c.records, 0);
      toast.message(records === 0 ? "Nothing to clean up" : "Preview ready", {
        description:
          records === 0
            ? "No eligible data was found in the selected categories."
            : `${formatCount(records)} eligible records found — nothing has been removed yet.`,
      });
    } catch (err) {
      toast.error(friendly(err, "Could not preview the cleanup."));
    } finally {
      setPreviewing(false);
    }
  }

  async function onRun() {
    setStarting(true);
    const expectedRecords = totals.records;
    try {
      const result = await start({ categories: selected });
      setConfirming(false);
      setPreview(null);
      onStarted(result.jobId, { total: expectedRecords, approximate: false });
      toast.success("Cleanup started", {
        description: "Only the eligible records shown in the preview were confirmed. Progress is reported below.",
      });
    } catch (err) {
      toast.error(friendly(err, "Could not start the cleanup."));
    } finally {
      setStarting(false);
    }
  }

  return (
    <Card className="border-white/10 bg-card/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="size-4 text-sky-300" /> General System Cleanup
        </CardTitle>
        <CardDescription>
          Remove data that is disposable by rule: expired records, and files or rows that nothing references any more.
          Nothing here can touch accounts, communities, groups, profiles, live sessions or attachments a message still
          uses.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {allowed.map((category) => {
            const row: CategoryRow | undefined = byId.get(category.id);
            const on = selected.includes(category.id);
            return (
              <div
                key={category.id}
                className={`rounded-lg border p-3 transition-colors ${
                  on ? "border-sky-400/30 bg-sky-400/[0.04]" : "border-white/10 bg-white/[0.02]"
                }`}
              >
                <label className="flex cursor-pointer items-start gap-3">
                  <Checkbox checked={on} onCheckedChange={(value) => toggle(category.id, value === true)} className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{category.label}</span>
                      {category.minRole === "owner" && (
                        <Badge variant="outline" className="border-amber-400/40 text-amber-300">
                          Owner Admin only
                        </Badge>
                      )}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">{category.description}</span>
                  </span>
                </label>

                <ul className="mt-2 list-disc space-y-1 pl-8 text-xs text-muted-foreground">
                  {category.includes.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                <p className="mt-2 pl-8 text-xs text-sky-200/70">{category.safety}</p>

                <div className="mt-2 pl-8 text-xs">
                  {row ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">
                        {row.atLeast ? "At least " : ""}
                        {formatCount(row.records)} record{row.records === 1 ? "" : "s"} eligible
                      </span>
                      {category.measurable && row.bytes > 0 && (
                        <span className="text-muted-foreground">{formatBytes(row.bytes)} recoverable</span>
                      )}
                      {row.note && <span className="text-amber-300">{row.note}</span>}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Preview to see how much is eligible here.</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Categories this administrator may not run, listed so the limit is visible. */}
        {permissions.categories.some((c) => !c.allowed) && (
          <p className="text-xs text-muted-foreground">
            Hidden from this account (Owner Admin only):{" "}
            {permissions.categories
              .filter((c) => !c.allowed)
              .map((c) => c.label)
              .join(", ")}
            .
          </p>
        )}

        <InfoNote>
          Preview Cleanup only scans and counts — it changes nothing, and it can be run as often as you like. Run
          Cleanup removes only the eligible items, in small batches, and stops safely if something goes wrong.
        </InfoNote>

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={onPreview} disabled={previewing}>
            {previewing ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
            Preview cleanup
          </Button>
          <Button
            variant="destructive"
            disabled={preview === null || totals.records === 0}
            onClick={() => setConfirming(true)}
          >
            Clean up{preview && totals.records > 0 ? ` ${formatCount(totals.records)} records` : ""}
          </Button>
        </div>
        {preview === null && (
          <p className="text-xs text-muted-foreground">
            Run a preview first: Clean up stays locked until the eligible records have been counted.
          </p>
        )}
      </CardContent>

      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clean up {formatCount(totals.records)} eligible records?</DialogTitle>
            <DialogDescription>
              {chosen.map((c) => c.label).join(" · ")}
              {totals.bytes > 0 ? ` · about ${formatBytes(totals.bytes)} recoverable` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">This will remove only the following, and nothing else:</p>
            <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {chosen.flatMap((c) => c.includes.map((line) => <li key={`${c.id}-${line}`}>{line}</li>))}
            </ul>
            <p className="text-sm text-destructive">
              Deletion is permanent. Active accounts, communities, groups, profiles, sessions and referenced
              attachments are never eligible. The cleanup can be cancelled while it runs — batches already completed
              stay deleted.
            </p>
            {includesOwnerOnlyCategory(selected) && (
              <DangerNote>
                This selection includes a category that requires Owner Admin authority; the server re-checks that
                before removing anything.
              </DangerNote>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={starting} onClick={onRun}>
              {starting ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
              Run cleanup
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** Live progress for the running job (a subscription, so it updates by itself). */
function JobProgress({ job, expectation }: { job: JobView; expectation: Expectation | null }) {
  const cancel = useMutation(api.cleanup.cancelJob);
  const running = job.status === "running";
  const affected = job.kind === "messages" ? job.messagesDeleted : job.recordsDeleted;
  const total = expectation && expectation.total > 0 ? expectation.total : 0;
  const rawPercent = total > 0 ? progressPercent(affected, total) : null;
  // A lower-bound total can be reached before the work is done, so a running job
  // is never shown at 100% — only a finished one is.
  const percent = rawPercent === null ? null : running ? Math.min(99, rawPercent) : 100;

  return (
    <Card className={`border-white/10 ${running ? "bg-sky-400/[0.04]" : "bg-card/40"}`}>
      <CardHeader className="gap-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {running ? (
            <Loader2 className="size-4 animate-spin text-sky-300" />
          ) : job.status === "completed" ? (
            <CheckCircle2 className="size-4 text-emerald-400" />
          ) : (
            <XCircle className="size-4 text-destructive" />
          )}
          {job.kind === "messages" ? "Message cleanup" : "System cleanup"}
          <Badge variant="outline" className="border-white/15 capitalize">
            {job.status}
          </Badge>
        </CardTitle>
        <CardDescription>
          {job.scopeLabel} · {job.rangeLabel}
          {job.categories.length > 0 ? ` · ${job.categories.length} categories` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {running && (
          <div className="space-y-2">
            {percent !== null && <Progress value={percent} />}
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {formatCount(affected)}
                {total > 0
                  ? ` of ${expectation?.approximate ? "at least " : ""}${formatCount(total)}`
                  : ""}{" "}
                {job.kind === "messages" ? "messages" : "records"} ·{" "}
                {percent === null ? "in progress" : `${percent}%`} · batch {job.batches}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  try {
                    await cancel({ jobId: job.jobId });
                    toast.message("Cancelling…", { description: "Batches already completed stay deleted." });
                  } catch (err) {
                    toast.error(friendly(err, "Could not cancel the cleanup."));
                  }
                }}
              >
                Stop cleanup
              </Button>
            </div>
          </div>
        )}

        <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
          <span>Channel messages deleted: {formatCount(job.channelMessagesDeleted)}</span>
          <span>Direct messages deleted: {formatCount(job.dmMessagesDeleted)}</span>
          <span>Records cleaned up: {formatCount(job.recordsDeleted)}</span>
          <span>Attached files removed: {formatCount(job.attachmentsDeleted)}</span>
          <span>Storage recovered: {job.bytesFreed > 0 ? formatBytes(job.bytesFreed) : "—"}</span>
          <span>Errors: {formatCount(job.errors)}</span>
        </div>

        {job.summary.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {job.summary.slice(-6).map((line, index) => (
              <li key={`${index}-${line}`}>{line}</li>
            ))}
          </ul>
        )}

        {!running && (
          <p className={job.status === "completed" ? "text-sm text-emerald-300" : "text-sm text-destructive"}>
            {job.lastError ?? job.result}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Cleanup history — durable, and preserved even though the messages are gone. */
function CleanupHistory({ rows }: { rows: HistoryRow[] | undefined }) {
  return (
    <Card className="border-white/10 bg-card/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="size-4" /> Cleanup history
        </CardTitle>
        <CardDescription>
          Who ran what, over which scope and time range, and what it affected. These records live in the audit log and
          are never removed by a cleanup — including the messages a cleanup deleted.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows === undefined && <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>}
        {rows && rows.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">No cleanup has been run yet.</p>
        )}
        {rows && rows.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Administrator</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Affected</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.jobId}>
                    <TableCell className="whitespace-nowrap text-xs">
                      {formatMoment(row.startedAt)}
                      {row.finishedAt ? (
                        <span className="block text-muted-foreground">
                          finished {formatMoment(row.finishedAt)}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs">{row.actorName}</TableCell>
                    <TableCell className="text-xs">
                      {row.kind === "messages" ? "Messages" : "System"}
                      <Badge variant="outline" className="ml-2 border-white/15 capitalize">
                        {row.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      {row.scopeLabel}
                      <span className="block text-muted-foreground">{row.rangeLabel}</span>
                    </TableCell>
                    <TableCell className="text-xs">
                      {row.messagesDeleted > 0 && (
                        <span className="block">{formatCount(row.messagesDeleted)} messages</span>
                      )}
                      {row.recordsDeleted > 0 && (
                        <span className="block">{formatCount(row.recordsDeleted)} records</span>
                      )}
                      {row.attachmentsDeleted > 0 && (
                        <span className="block">{formatCount(row.attachmentsDeleted)} files</span>
                      )}
                      {row.bytesFreed > 0 && (
                        <span className="block text-muted-foreground">{formatBytes(row.bytesFreed)}</span>
                      )}
                      {row.messagesDeleted + row.recordsDeleted + row.attachmentsDeleted === 0 && "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {row.result}
                      {row.errors > 0 && <span className="block text-destructive">{row.errors} error(s)</span>}
                      {row.lastError && <span className="block text-destructive">{row.lastError}</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The tab's shell. Renders nothing that is not permitted — and the server refuses
 * these calls anyway, so this is presentation only.
 */
export default function CleanupMaintenance({ panelOpen }: { panelOpen: boolean }) {
  const permissions = useQuery(api.cleanup.permissions, panelOpen ? {} : "skip");
  const history = useQuery(api.cleanup.history, panelOpen ? { limit: CLEANUP_HISTORY_LIMIT } : "skip");

  // The job the panel is watching. One started here is followed to its result; a
  // cleanup that was already running (started before this panel opened, or by the
  // other tool) is discovered from the live history, so its progress and its Stop
  // button appear as well — no effect, no synthetic state.
  const [activeJobId, setActiveJobId] = useState<Id<"cleanupJobs"> | null>(null);
  const [expectation, setExpectation] = useState<Expectation | null>(null);
  const runningRow = history?.find((row) => row.status === "running") ?? null;
  const watchedJobId = activeJobId ?? runningRow?.jobId ?? null;
  const watchedExpectation: Expectation | null = activeJobId
    ? expectation
    : runningRow
      ? { total: runningRow.messagesDeleted + runningRow.recordsDeleted, approximate: true }
      : null;
  const job = useQuery(api.cleanup.job, panelOpen && watchedJobId ? { jobId: watchedJobId } : "skip");

  // Announce an outcome exactly once. Only a cleanup started in THIS session is
  // toasted; one found in history is simply displayed, never re-announced.
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (!activeJobId || !job || job.status === "running" || announced.current === job.jobId) return;
    announced.current = job.jobId;
    if (job.status === "completed") toast.success(job.result);
    else if (job.status === "cancelled") {
      toast.message("Cleanup cancelled", { description: "Batches already completed stay deleted." });
    } else toast.error(job.lastError ?? "The cleanup failed.");
  }, [activeJobId, job]);

  if (permissions === undefined) {
    return (
      <Card className="border-white/10 bg-card/40">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">Loading cleanup tools…</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <FeatureBoundary label="Cleanup & Maintenance">
        <MessageCleanup
          permissions={permissions}
          onStarted={(jobId, next) => {
            setActiveJobId(jobId);
            setExpectation(next);
          }}
        />
      </FeatureBoundary>

      <FeatureBoundary label="General system cleanup">
        <GeneralCleanup
          permissions={permissions}
          onStarted={(jobId, next) => {
            setActiveJobId(jobId);
            setExpectation(next);
          }}
        />
      </FeatureBoundary>

      {job && <JobProgress job={job} expectation={watchedExpectation} />}

      <FeatureBoundary label="Cleanup history">
        <CleanupHistory rows={history} />
      </FeatureBoundary>

      <Card className="border-white/10 bg-card/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="size-4 text-amber-300" /> Recovery and backups
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-muted-foreground">
          <p>
            Freecord keeps <span className="text-foreground">no copy</span> of deleted messages, so a message cleanup
            cannot be undone from inside the app. The confirmation dialog, the preview count and the required
            site-wide phrase exist because of that.
          </p>
          <p>
            The database provider (Convex) can offer deployment backups, depending on the deployment&apos;s plan, and
            those are managed in the Convex dashboard — not here. This panel never creates, restores or deletes
            backups, and General System Cleanup never touches them. If backups are available for this deployment and
            you need to recover data, restore the snapshot from the Convex dashboard; note that a restore replaces the
            current database with the snapshot, so any messages sent after it are lost too.
          </p>
          <p>
            Cleanup history and the audit log are ordinary rows, preserved through any cleanup, and list the
            administrator, the action, the scope, the time range (with the time zone applied), the affected records
            and the outcome.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
