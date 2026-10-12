// Unit tests for the Admin Panel "My Deleted Messages" retention rules.
// Run: bun deleted-messages-test.mjs
//
// These are the EXACT rules the server query applies (src/convex/adminMessages.ts
// imports them), so they prove:
//   - only messages I sent AND deleted for myself are ever listable,
//   - another member's local delete can never appear in my panel,
//   - a message deleted for everyone is never presented as recoverable content,
//   - a message with nothing retained (no body, attachments or GIF) is ignored,
//   - a "delete for me" entry disappears SEVEN DAYS after I deleted it, while
//     newer entries stay listed and the messages themselves are never involved.
//
// Everything here runs with a FIXED clock (`NOW`), so the seven-day boundary is
// asserted exactly instead of depending on the machine's date.
import {
  DELETED_FOR_ME_TTL_MS,
  DELETED_PREVIEW_MAX,
  deletedForMeExpiresAt,
  deletedForMeRemainingLabel,
  deletedForMeRemainingMs,
  deletedMessagePreview,
  hasRetainedContent,
  isDeletedForMeExpired,
  isRetainedHiddenMessage,
  isRetainedOwnDeletion,
  matchesDeletedMessageSearch,
} from "./src/lib/deleted-messages";

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, e) => { fail++; console.log(`FAIL: ${name} -> ${e ?? ""}`); };

function is(name, got, expected) {
  if (got === expected) ok(name);
  else bad(name, `got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
}

const ME = "user_me", OTHER = "user_other";

/** The fixed "now" every case is judged against. */
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/** A local delete that just happened (window wide open). */
const FRESH = { hiddenAt: NOW - MINUTE, now: NOW };

/** A local delete made exactly seven days ago (window just closed). */
const SEVEN_DAYS_OLD = { hiddenAt: NOW - DELETED_FOR_ME_TTL_MS, now: NOW };

/** A baseline: my own message, hidden by me, still in storage with text. */
const mine = {
  viewerId: ME,
  hiddenByUserId: ME,
  messageExists: true,
  messageSenderId: ME,
  deletedForEveryone: false,
  body: "hello",
  attachmentCount: 0,
  hasGif: false,
  ...FRESH,
};

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------
is("my own retained local delete is eligible", isRetainedOwnDeletion(mine), true);
is("an attachment-only message of mine is eligible", isRetainedOwnDeletion({ ...mine, body: "", attachmentCount: 1 }), true);
is("a GIF-only message of mine is eligible", isRetainedOwnDeletion({ ...mine, body: "", hasGif: true }), true);
is("a message I did not hide is not eligible", isRetainedOwnDeletion({ ...mine, hiddenByUserId: OTHER }), false);
is("another member's message hidden by me is not eligible", isRetainedOwnDeletion({ ...mine, messageSenderId: OTHER }), false);
is("a message that no longer exists is not eligible", isRetainedOwnDeletion({ ...mine, messageExists: false }), false);
is("a message deleted for everyone is not eligible", isRetainedOwnDeletion({ ...mine, deletedForEveryone: true }), false);
is("an empty message with nothing retained is not eligible", isRetainedOwnDeletion({ ...mine, body: "   " }), false);
is("missing optional facts do not make a row eligible", isRetainedOwnDeletion({
  viewerId: ME, hiddenByUserId: ME, messageExists: true, messageSenderId: ME, deletedForEveryone: false, ...FRESH,
}), false);
is("an unknown sender is never eligible", isRetainedOwnDeletion({ ...mine, messageSenderId: undefined }), false);

// ---------------------------------------------------------------------------
// The seven-day retention window (fixed clock)
// ---------------------------------------------------------------------------
is("the window is exactly seven days long", DELETED_FOR_ME_TTL_MS, 7 * DAY);
is("a delete from a minute ago is not expired", isDeletedForMeExpired(NOW - MINUTE, NOW), false);
is("a delete from six days ago is not expired", isDeletedForMeExpired(NOW - 6 * DAY, NOW), false);
is("a delete from 7 days minus a minute is not expired", isDeletedForMeExpired(NOW - (7 * DAY - MINUTE), NOW), false);
is("a delete from exactly seven days ago IS expired", isDeletedForMeExpired(NOW - 7 * DAY, NOW), true);
is("a delete from 7 days and a minute ago is expired", isDeletedForMeExpired(NOW - (7 * DAY + MINUTE), NOW), true);
is("the window's closing instant is hiddenAt + 7 days", deletedForMeExpiresAt(NOW), NOW + 7 * DAY);
is("a marker with no usable timestamp fails closed", isDeletedForMeExpired(Number.NaN, NOW), true);

// Remaining-time helpers (what the panel displays).
is("a fresh delete has nearly the full window left", deletedForMeRemainingMs(NOW - MINUTE, NOW), 7 * DAY - MINUTE);
is("an expired delete has nothing left", deletedForMeRemainingMs(NOW - 8 * DAY, NOW), 0);
is("remaining time is labelled in days and hours", deletedForMeRemainingLabel(NOW - 1 * DAY, NOW), "6d");
is("remaining time is labelled in hours near the end", deletedForMeRemainingLabel(NOW - (7 * DAY - 5 * 60 * MINUTE), NOW), "5 h");
is("remaining time is labelled in minutes at the very end", deletedForMeRemainingLabel(NOW - (7 * DAY - 30 * MINUTE), NOW), "30 min");
is("an expired delete is labelled as expired", deletedForMeRemainingLabel(NOW - 8 * DAY, NOW), "expired");

// Eligibility follows the window: newer entries stay, older ones go.
is("an entry inside the window is still listed", isRetainedOwnDeletion({ ...mine, hiddenAt: NOW - 6 * DAY }), true);
is("an entry exactly at the boundary is no longer listed", isRetainedOwnDeletion({ ...mine, ...SEVEN_DAYS_OLD }), false);
is("an entry past the window is no longer listed", isRetainedOwnDeletion({ ...mine, hiddenAt: NOW - 8 * DAY }), false);
is("a marked-expired entry is not listed even inside the window",
  isRetainedOwnDeletion({ ...mine, entryExpiredAt: NOW }), false);
is("another user's older entry does not expire MY fresh entry", (() => {
  // Two DIFFERENT markers judged against the same instant: mine fresh, theirs old.
  const theirs = { ...mine, viewerId: OTHER, hiddenByUserId: OTHER, messageSenderId: OTHER, hiddenAt: NOW - 9 * DAY };
  return isRetainedOwnDeletion(mine) === true && isRetainedHiddenMessage(theirs) === false;
})(), true);
is("each entry is judged against its own hiddenAt, not the newest one", (() => {
  const old = { ...mine, hiddenAt: NOW - 9 * DAY };
  const fresh = { ...mine, hiddenAt: NOW - MINUTE };
  return isRetainedOwnDeletion(old) === false && isRetainedOwnDeletion(fresh) === true;
})(), true);

// The message itself is never part of the decision: its body, GIF and
// attachments stay exactly as they are (nothing is deleted when an entry
// expires — the entry is only no longer listable).
is("an expired entry still reports its untouched content", (() => {
  const expired = { ...mine, hiddenAt: NOW - 8 * DAY, body: "still here", attachmentCount: 2, hasGif: true };
  return isRetainedOwnDeletion(expired) === false && hasRetainedContent(expired) === true;
})(), true);
is("expiry is per marker, so the same message can stay retained for me", (() => {
  // The message row is shared; only MY marker is judged here.
  const sharedMessageFacts = { messageExists: true, messageSenderId: ME, deletedForEveryone: false, body: "same row" };
  const myExpired = { ...sharedMessageFacts, viewerId: ME, hiddenByUserId: ME, hiddenAt: NOW - 8 * DAY, now: NOW };
  const myFresh = { ...sharedMessageFacts, viewerId: ME, hiddenByUserId: ME, hiddenAt: NOW - 1 * DAY, now: NOW };
  const otherFresh = { ...sharedMessageFacts, viewerId: OTHER, hiddenByUserId: OTHER, hiddenAt: NOW - 1 * DAY, now: NOW };
  return isRetainedHiddenMessage(myExpired) === false
    && isRetainedHiddenMessage(myFresh) === true
    && isRetainedHiddenMessage(otherFresh) === true;
})(), true);

// ---------------------------------------------------------------------------
// The administrator moderation rule (any sender, still retained)
// ---------------------------------------------------------------------------
is("a moderator may reach another member's hidden message", isRetainedHiddenMessage({
  viewerId: ME, hiddenByUserId: ME, messageExists: true, messageSenderId: OTHER,
  deletedForEveryone: false, body: "their message", ...FRESH,
}), true);
is("but only for a message they hid themselves", isRetainedHiddenMessage({
  viewerId: ME, hiddenByUserId: OTHER, messageExists: true, messageSenderId: OTHER,
  deletedForEveryone: false, body: "their message", ...FRESH,
}), false);
is("a moderation target deleted for everyone is never listed", isRetainedHiddenMessage({
  viewerId: ME, hiddenByUserId: ME, messageExists: true, messageSenderId: OTHER,
  deletedForEveryone: true, body: "their message", ...FRESH,
}), false);
is("a moderation target past the retention window is never listed", isRetainedHiddenMessage({
  viewerId: ME, hiddenByUserId: ME, messageExists: true, messageSenderId: OTHER,
  deletedForEveryone: false, body: "their message", ...SEVEN_DAYS_OLD,
}), false);
is("an attachment-only moderation target is still eligible", isRetainedHiddenMessage({
  viewerId: ME, hiddenByUserId: ME, messageExists: true, messageSenderId: OTHER,
  deletedForEveryone: false, body: "", attachmentCount: 1, ...FRESH,
}), true);
is("the own-sender rule is exactly the strict variant",
  isRetainedOwnDeletion({ viewerId: ME, hiddenByUserId: ME, messageExists: true, messageSenderId: OTHER, deletedForEveryone: false, body: "x", ...FRESH }), false);
is("whitespace-only body has no retained content", hasRetainedContent({ body: "\n\t  " }), false);
is("a GIF counts as retained content", hasRetainedContent({ body: "", hasGif: true }), true);
is("an attachment counts as retained content", hasRetainedContent({ attachmentCount: 2 }), true);

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------
is("preview collapses whitespace", deletedMessagePreview({ body: "a\n\n  b\tc" }), "a b c");
is("preview falls back to a single attachment name", deletedMessagePreview({ body: "", attachmentNames: ["report.pdf"] }), "Attachment: report.pdf");
is("preview counts multiple attachments", deletedMessagePreview({ attachmentNames: ["a.png", "b.png", "c.png"] }), "3 attachments");
is("preview names a GIF", deletedMessagePreview({ body: null, hasGif: true }), "GIF");
is("preview is honest when nothing is retained", deletedMessagePreview({}), "(no text content)");

const long = "x".repeat(DELETED_PREVIEW_MAX + 50);
const clipped = deletedMessagePreview({ body: long });
is(`long previews are clipped to ${DELETED_PREVIEW_MAX} chars`, clipped.length, DELETED_PREVIEW_MAX);
is("a clipped preview ends with an ellipsis", clipped.endsWith("…"), true);
is("short previews are not clipped", deletedMessagePreview({ body: "ok" }), "ok");

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
const fields = { body: "Sprint Planning Notes", conversationName: "#general", attachmentNames: ["budget.xlsx"] };
is("an empty term matches everything", matchesDeletedMessageSearch(fields, ""), true);
is("a whitespace-only term matches everything", matchesDeletedMessageSearch(fields, "   "), true);
is("body matching is case-insensitive", matchesDeletedMessageSearch(fields, "sprint planning"), true);
is("conversation names are searchable", matchesDeletedMessageSearch(fields, "#general"), true);
is("attachment names are searchable", matchesDeletedMessageSearch(fields, "budget"), true);
is("a term nothing contains does not match", matchesDeletedMessageSearch(fields, "zebra"), false);
is("missing fields never throw", matchesDeletedMessageSearch({}, "anything"), false);
is("an empty search of empty fields matches", matchesDeletedMessageSearch({}, ""), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
