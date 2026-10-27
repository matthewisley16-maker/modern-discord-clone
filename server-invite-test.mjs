// Unit tests for the shared server-invitation rules used by the DM card, the
// invite dialog and the Convex backend. They encode the behaviour the product
// spec requires: pending → joined → expired/revoked/declined/invalid, a 7-day
// window, deduped recipients that never include the sender, and safe labels.
// Run: bun server-invite-test.mjs
import {
  canRespondToInvite,
  inviteCardAccess,
  inviteExpiryLabel,
  inviteRecipients,
  inviteSendLabel,
  inviteViewStatus,
  INVITE_STATUS_LABEL,
  INVITE_TTL_MS,
  MAX_INVITE_RECIPIENTS,
} from "./src/lib/server-invites";

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, e) => { fail++; console.log(`FAIL: ${name} -> ${e ?? ""}`); };

function eq(name, got, expected) {
  const g = JSON.stringify(got), x = JSON.stringify(expected);
  if (g === x) ok(name); else bad(name, `got ${g}, expected ${x}`);
}

const now = Date.UTC(2026, 0, 10, 12, 0, 0);
const live = { status: "pending", expiresAt: now + INVITE_TTL_MS };
const expired = { status: "pending", expiresAt: now - 1 };

// ---- status resolution ----
eq("a fresh pending invite is pending", inviteViewStatus(live, now), "pending");
eq("a past-due pending invite is expired", inviteViewStatus(expired, now), "expired");
eq("an accepted invite reads joined", inviteViewStatus({ ...live, status: "accepted" }, now), "joined");
eq("a declined invite stays declined", inviteViewStatus({ ...live, status: "declined" }, now), "declined");
eq("a revoked invite reads revoked (not expired)", inviteViewStatus({ ...expired, status: "revoked" }, now), "revoked");
eq("real membership wins over pending", inviteViewStatus(live, now, true), "joined");
eq("real membership wins over declined", inviteViewStatus({ ...live, status: "declined" }, now, true), "joined");
eq("a missing row is invalid", inviteViewStatus(null, now), "invalid");
eq("a row without an expiry is invalid", inviteViewStatus({ status: "pending" }, now), "invalid");
eq("the expiry boundary is exclusive", inviteViewStatus({ status: "pending", expiresAt: now }, now), "expired");

// ---- labels ----
for (const status of ["pending", "joined", "declined", "revoked", "expired", "invalid"]) {
  if (INVITE_STATUS_LABEL[status]) ok(`label exists for ${status}`);
  else bad(`label exists for ${status}`);
}
eq("pending label", INVITE_STATUS_LABEL.pending, "Invite Pending");
eq("joined label", INVITE_STATUS_LABEL.joined, "Joined");
eq("expired label", INVITE_STATUS_LABEL.expired, "Expired");
eq("invalid label", INVITE_STATUS_LABEL.invalid, "Invalid");

// ---- only pending can be acted on ----
eq("pending is actionable", canRespondToInvite("pending"), true);
for (const status of ["joined", "declined", "revoked", "expired", "invalid"]) {
  eq(`${status} is not actionable`, canRespondToInvite(status), false);
}

// ---- expiry wording ----
eq("expired wording", inviteExpiryLabel(now - 1000, now), "Expired");
eq("under an hour", inviteExpiryLabel(now + 30 * 60_000, now), "Expires in under an hour");
eq("hours", inviteExpiryLabel(now + 5 * 3_600_000, now), "Expires in 5 hours");
eq("under a day stays in hours", inviteExpiryLabel(now + 20 * 3_600_000, now), "Expires in 20 hours");
eq("one day", inviteExpiryLabel(now + 24 * 3_600_000, now), "Expires in 1 day");
eq("a week", inviteExpiryLabel(now + INVITE_TTL_MS, now), "Expires in 7 days");
eq("no expiry value -> empty", inviteExpiryLabel(undefined, now), "");

// ---- recipient selection ----
eq("sender is removed", inviteRecipients(["a", "me", "b"], "me"), ["a", "b"]);
eq("duplicates collapse", inviteRecipients(["a", "a", "a"], "me"), ["a"]);
eq("non-strings are ignored", inviteRecipients(["a", null, 3, "", "b"], "me"), ["a", "b"]);
eq("null is tolerated", inviteRecipients(null, "me"), []);
eq("undefined is tolerated", inviteRecipients(undefined, "me"), []);
eq("the cap is applied", inviteRecipients(Array.from({ length: 50 }, (_, i) => `u${i}`), "me").length, MAX_INVITE_RECIPIENTS);
eq("the default cap is 20", MAX_INVITE_RECIPIENTS, 20);
eq("a custom cap is honoured", inviteRecipients(["a", "b", "c"], "me", 2), ["a", "b"]);
eq("an invalid cap falls back safely", inviteRecipients(["a"], "me", 0), ["a"]);

// ---- who may act on a card (addressed vs posted invitations) ----
const addressed = { ...live, recipientId: "me", inviterId: "sender" };
const addressedToOther = { ...live, recipientId: "someone", inviterId: "sender" };
// A POSTED invitation has no addressee: it was shared into a channel.
const posted = { ...live, recipientId: undefined, inviterId: "sender" };
const access = (invite, viewer, member = false) => inviteCardAccess(invite, viewer, member, now);

eq("an addressed invite is actionable by its recipient", access(addressed, "me"),
  { status: "pending", isOpen: false, mayAccept: true, mayDecline: true });
eq("an addressed invite is not actionable by anyone else", access(addressedToOther, "me").mayAccept, false);
eq("an addressed invite cannot be declined by a bystander", access(addressedToOther, "me").mayDecline, false);
eq("an addressed invite reads joined once the recipient is a member", access(addressed, "me", true).status, "joined");
eq("an addressed invite stops being actionable once joined", access(addressed, "me", true).mayAccept, false);

eq("a posted invite is open, not addressed", access(posted, "viewer").isOpen, true);
eq("any member who can see a posted invite may accept it", access(posted, "viewer"),
  { status: "pending", isOpen: true, mayAccept: true, mayDecline: false });
eq("a posted invite can never be declined (it is shared)", access(posted, "viewer").mayDecline, false);
eq("the poster cannot accept their own posted invite", access(posted, "sender").mayAccept, false);
eq("an existing member sees a posted invite as joined", access(posted, "viewer", true).status, "joined");
eq("an existing member cannot accept a posted invite again", access(posted, "viewer", true).mayAccept, false);
eq("an expired posted invite is not actionable", access({ ...posted, expiresAt: now - 1 }, "viewer"),
  { status: "expired", isOpen: true, mayAccept: false, mayDecline: false });
eq("a revoked posted invite is not actionable", access({ ...posted, status: "revoked" }, "viewer").mayAccept, false);
eq("a declined posted invite is not actionable", access({ ...posted, status: "declined" }, "viewer").mayAccept, false);
eq("a missing invitation is invalid and inert", access(null, "viewer"),
  { status: "invalid", isOpen: false, mayAccept: false, mayDecline: false });

// ---- button wording ----
eq("no selection", inviteSendLabel(0), "Send invitation");
eq("one person", inviteSendLabel(1), "Send invitation");
eq("several people", inviteSendLabel(3), "Send 3 invitations");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
