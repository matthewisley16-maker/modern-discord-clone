// Unit tests for the call-invitation rules that src/convex/calls.ts enforces
// server-side: the TTL, the "only a pending, unexpired invitation may be used"
// invariant, and the duplicate guard that points at ONE specific call.
// Run: bun call-invitations-test.mjs
import { INVITATION_TTL_MS, isAcceptable, isLiveInvitationFor } from "./src/lib/call-invitations";

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, e) => { fail++; console.log(`FAIL: ${name} -> ${e ?? ""}`); };

function eq(name, got, expected) {
  const g = JSON.stringify(got), x = JSON.stringify(expected);
  if (g === x) ok(name); else bad(name, `got ${g}, expected ${x}`);
}

const NOW = 1_700_000_000_000;
const row = (over = {}) => ({ status: "pending", expiresAt: NOW + 60_000, fromId: "userA", ...over });

// ---- TTL ------------------------------------------------------------------
eq("invitations last 15 minutes", INVITATION_TTL_MS, 15 * 60_000);

// ---- isAcceptable ---------------------------------------------------------
eq("pending + future expiry is acceptable", isAcceptable(row(), NOW), true);
eq("pending that just expired is not acceptable", isAcceptable(row({ expiresAt: NOW }), NOW), false);
eq("pending expired long ago is not acceptable", isAcceptable(row({ expiresAt: NOW - 1 }), NOW), false);
for (const status of ["accepted", "declined", "cancelled", "expired"]) {
  eq(`resolved status "${status}" is never acceptable`, isAcceptable(row({ status }), NOW), false);
  eq(`resolved status "${status}" is not acceptable even before its TTL`, isAcceptable(row({ status, expiresAt: NOW + 9_000_000 }), NOW), false);
}
eq("a resolved row can be re-checked as pending-like without throwing", isAcceptable({ status: "declined", expiresAt: NOW + 1 }, NOW), false);

// ---- isLiveInvitationFor: sender -----------------------------------------
const call = { fromId: "userA", channelId: "chan1" };
eq("live invitation from the same sender for the same call matches",
  isLiveInvitationFor(row(call), { fromId: "userA", channelId: "chan1", now: NOW }), true);
eq("invitation from somebody else never matches",
  isLiveInvitationFor(row(call), { fromId: "userB", channelId: "chan1", now: NOW }), false);

// ---- isLiveInvitationFor: which call -------------------------------------
eq("channel invitation does not match another channel",
  isLiveInvitationFor(row(call), { fromId: "userA", channelId: "chan2", now: NOW }), false);
eq("channel invitation is not a duplicate of the conversation call",
  isLiveInvitationFor(row(call), { fromId: "userA", conversationId: "conv1", now: NOW }), false);
eq("conversation invitation matches the same conversation",
  isLiveInvitationFor(row({ fromId: "userA", conversationId: "conv1" }), { fromId: "userA", conversationId: "conv1", now: NOW }), true);
eq("conversation invitation does not match another conversation",
  isLiveInvitationFor(row({ fromId: "userA", conversationId: "conv1" }), { fromId: "userA", conversationId: "conv2", now: NOW }), false);
eq("conversation invitation is not a duplicate of the channel call",
  isLiveInvitationFor(row({ fromId: "userA", conversationId: "conv1" }), { fromId: "userA", channelId: "chan1", now: NOW }), false);
eq("no call target on either side is never a match",
  isLiveInvitationFor(row({ fromId: "userA" }), { fromId: "userA", now: NOW }), false);

// ---- isLiveInvitationFor: only a LIVE row --------------------------------
eq("an expired invitation stops being a duplicate",
  isLiveInvitationFor(row({ ...call, expiresAt: NOW }), { fromId: "userA", channelId: "chan1", now: NOW }), false);
for (const status of ["accepted", "declined", "cancelled", "expired"]) {
  eq(`a "${status}" invitation stops being a duplicate`,
    isLiveInvitationFor(row({ ...call, status }), { fromId: "userA", channelId: "chan1", now: NOW }), false);
}

// ---- Real shapes produced by calls.ts ------------------------------------
// Pending invitation to a community channel, as inserted by inviteToCommunityCall.
const communityInvite = { status: "pending", expiresAt: NOW + INVITATION_TTL_MS, fromId: "userA", channelId: "chan1", conversationId: undefined };
eq("community invite is live for its own channel a second later",
  isLiveInvitationFor(communityInvite, { fromId: "userA", channelId: "chan1", now: NOW + 1_000 }), true);
eq("community invite is dead once its TTL has elapsed",
  isLiveInvitationFor(communityInvite, { fromId: "userA", channelId: "chan1", now: NOW + INVITATION_TTL_MS + 1 }), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
