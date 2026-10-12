// Unit tests for the Admin Panel "My Deleted Messages" retention rules.
// Run: bun deleted-messages-test.mjs
//
// These are the EXACT rules the server query applies (src/convex/adminMessages.ts
// imports them), so they prove:
//   - only messages I sent AND deleted for myself are ever listable,
//   - another member's local delete can never appear in my panel,
//   - a message deleted for everyone is never presented as recoverable content,
//   - a message with nothing retained (no body, attachments or GIF) is ignored.
import {
  DELETED_PREVIEW_MAX,
  deletedMessagePreview,
  hasRetainedContent,
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
  viewerId: ME, hiddenByUserId: ME, messageExists: true, messageSenderId: ME, deletedForEveryone: false,
}), false);
is("an unknown sender is never eligible", isRetainedOwnDeletion({ ...mine, messageSenderId: undefined }), false);

// ---------------------------------------------------------------------------
// The administrator moderation rule (any sender, still retained)
// ---------------------------------------------------------------------------
is("a moderator may reach another member's hidden message", isRetainedHiddenMessage({
  viewerId: ME, hiddenByUserId: ME, messageExists: true, messageSenderId: OTHER,
  deletedForEveryone: false, body: "their message",
}), true);
is("but only for a message they hid themselves", isRetainedHiddenMessage({
  viewerId: ME, hiddenByUserId: OTHER, messageExists: true, messageSenderId: OTHER,
  deletedForEveryone: false, body: "their message",
}), false);
is("a moderation target deleted for everyone is never listed", isRetainedHiddenMessage({
  viewerId: ME, hiddenByUserId: ME, messageExists: true, messageSenderId: OTHER,
  deletedForEveryone: true, body: "their message",
}), false);
is("an attachment-only moderation target is still eligible", isRetainedHiddenMessage({
  viewerId: ME, hiddenByUserId: ME, messageExists: true, messageSenderId: OTHER,
  deletedForEveryone: false, body: "", attachmentCount: 1,
}), true);
is("the own-sender rule is exactly the strict variant",
  isRetainedOwnDeletion({ viewerId: ME, hiddenByUserId: ME, messageExists: true, messageSenderId: OTHER, deletedForEveryone: false, body: "x" }), false);
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
