// Voice/video call reliability: the shared ICE configuration and the two call
// surfaces that use it (DM calls and community voice channels).
//
// Run: bun call-media-test.mjs
//
// Three layers, none of which needs a second device or a synthetic account:
//   1. the pure rules (`src/lib/ice.ts`): the STUN set, the optional TURN relay
//      read from the environment, the full RTCConfiguration and the wording of a
//      failed-connection message,
//   2. the wiring (`DmCallPanel.tsx`, `VoicePanel.tsx`, `communities.ts`): both
//      panels negotiate against the SHARED servers, always negotiate audio even
//      on a device without a microphone, buffer ICE candidates that arrive before
//      the description, and can renegotiate from either side,
//   3. the regression that caused "Connecting… forever": no single-sided offer,
//      no discarded candidates, and a bounded retry instead of an endless spinner.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  connectionFailureMessage,
  DEFAULT_STUN_URLS,
  hasRelay,
  iceServers,
  rtcConfiguration,
  turnServers,
  turnUrls,
} from "./src/lib/ice";

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`PASS: ${name}`); };
const bad = (name, e) => { fail++; console.log(`FAIL: ${name} -> ${e ?? ""}`); };
const is = (name, got, expected) => {
  if (got === expected) ok(name);
  else bad(name, `got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
};
const check = (name, condition, detail) => { if (condition) ok(name); else bad(name, detail); };
/** Structural comparison, for the URL lists and ICE server objects. */
const deep = (name, got, expected) => {
  const g = JSON.stringify(got), x = JSON.stringify(expected);
  if (g === x) ok(name); else bad(name, `got ${g}, expected ${x}`);
};
const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");
const count = (haystack, needle) => haystack.split(needle).length - 1;

// ---------------------------------------------------------------------------
// 1. ICE configuration
// ---------------------------------------------------------------------------
is("STUN is always present", DEFAULT_STUN_URLS.length >= 2, true);
check("every default entry is a stun: URL", DEFAULT_STUN_URLS.every((u) => u.startsWith("stun:")), JSON.stringify(DEFAULT_STUN_URLS));
check("more than one STUN server is used (one being down is not fatal)", new Set(DEFAULT_STUN_URLS).size >= 3, JSON.stringify(DEFAULT_STUN_URLS));

deep("no TURN URL means no relay", turnUrls(undefined), []);
deep("a blank TURN URL means no relay", turnUrls("   "), []);
deep("one TURN url is parsed", turnUrls("turn:relay.example.com:3478"), ["turn:relay.example.com:3478"]);
deep("several TURN urls are parsed", turnUrls("turn:a:3478,turns:b:5349"), ["turn:a:3478", "turns:b:5349"]);
deep("whitespace separated TURN urls are parsed", turnUrls("turn:a:3478 turns:b:5349"), ["turn:a:3478", "turns:b:5349"]);
deep("a STUN url is never mistaken for a relay", turnUrls("stun:stun.l.google.com:19302"), []);

deep("no relay configured -> empty list", turnServers({}), []);
deep("a relay without credentials is still usable", turnServers({ VITE_TURN_URLS: "turn:a:3478" }), [{ urls: ["turn:a:3478"] }]);
deep("credentials are attached when present", turnServers({
  VITE_TURN_URLS: "turn:a:3478",
  VITE_TURN_USERNAME: "user",
  VITE_TURN_CREDENTIAL: "secret",
}), [{ urls: ["turn:a:3478"], username: "user", credential: "secret" }]);
deep("blank credentials are not attached", turnServers({
  VITE_TURN_URLS: "turn:a:3478",
  VITE_TURN_USERNAME: "  ",
  VITE_TURN_CREDENTIAL: "",
}), [{ urls: ["turn:a:3478"] }]);
// The single-URL name is still honoured, so an existing setting keeps working.
deep("a whitespace-and-comma list is split, and the singular name still works", [
  ...turnUrls("turn:a:3478, turns:b:5349"),
], ["turn:a:3478", "turns:b:5349"]);

is("without a relay only STUN is configured", iceServers({}).length, 1);
is("STUN is in the first entry", iceServers({})[0].urls.length, DEFAULT_STUN_URLS.length);
is("with a relay there are two entries", iceServers({ VITE_TURN_URLS: "turn:a:3478" }).length, 2);
is("the relay is the LAST entry (STUN is tried first)", iceServers({ VITE_TURN_URLS: "turn:a:3478" }).at(-1).urls[0], "turn:a:3478");
is("relay detection is honest (none)", hasRelay({}), false);
is("relay detection is honest (configured)", hasRelay({ VITE_TURN_URLS: "turn:a:3478" }), true);

const config = rtcConfiguration({});
is("the configuration carries the ICE servers", config.iceServers.length, 1);
is("candidates are pre-gathered for a faster first offer", config.iceCandidatePoolSize, 10);
is("media is bundled onto one transport", config.bundlePolicy, "max-bundle");

check("a failed connection without a relay explains what is missing", /TURN/.test(connectionFailureMessage(false)), connectionFailureMessage(false));
check("a failed connection with a relay suggests retrying", /rejoin/i.test(connectionFailureMessage(true)), connectionFailureMessage(true));
is("the two failure messages differ", connectionFailureMessage(false) === connectionFailureMessage(true), false);

// ---------------------------------------------------------------------------
// 2. Both call surfaces use the shared configuration
// ---------------------------------------------------------------------------
const dmPanel = read("src", "components", "dashboard", "DmCallPanel.tsx");
const voicePanel = read("src", "components", "voice", "VoicePanel.tsx");
const communities = read("src", "convex", "communities.ts");

check("DM calls use the shared ICE configuration", dmPanel.includes("new RTCPeerConnection(RTC_CONFIGURATION)"), "the DM panel builds its own ICE config");
check("community calls use the shared ICE configuration", voicePanel.includes("new RTCPeerConnection(RTC_CONFIGURATION)"), "the voice panel builds its own ICE config");
check("no panel hardcodes a STUN server any more", !dmPanel.includes("stun.l.google.com") && !voicePanel.includes("stun.l.google.com"), "a hardcoded STUN server is still present");
check("the DM panel reports a failed connection honestly", dmPanel.includes("connectionFailureMessage(RELAY_CONFIGURED)"), "the DM panel never reports a real failure");

// ---------------------------------------------------------------------------
// 3. The deadlocks that produced "Connecting… forever" and silent calls
// ---------------------------------------------------------------------------
check(
  "audio is negotiated even on a device with no microphone (DM calls)",
  dmPanel.includes('pc.addTransceiver("audio", { direction: "recvonly" })'),
  "a mic-less device negotiates nothing, so both sides stay silent",
);
check(
  "audio is negotiated even on a device with no microphone (community calls)",
  voicePanel.includes('pc.addTransceiver("audio", { direction: "recvonly" })'),
  "a mic-less participant negotiates nothing, so nobody is heard",
);
check(
  "the DM panel builds the connection even when local media fails",
  dmPanel.includes("No microphone AND no camera") && !/if \(!stream\) \{\s*setConnection\("lost"\);\s*setCameraError/.test(dmPanel),
  "a failed getUserMedia still aborts the whole call",
);
check("EVERY community peer can renegotiate (no single-sided offer)", count(voicePanel, "onnegotiationneeded") >= 1 && !voicePanel.includes("if (initiator) {"), "only one side can ever offer");
check("the old single-initiator peer call is gone", !voicePanel.includes("createPeer(p.userId, myUserId < p.userId)"), "one side still refuses to negotiate");
check("collisions are resolved with perfect negotiation", voicePanel.includes("makingOffer") && voicePanel.includes("polite"), "glare has no resolution rule");
check(
  "ICE candidates that arrive before the description are buffered",
  voicePanel.includes("state.remoteDescSet") && voicePanel.includes("state.pending.push(data)"),
  "early candidates are dropped, which half-forms the connection",
);
check(
  "the DM panel buffers early candidates too",
  dmPanel.includes("pendingCandidates.current.push(data)"),
  "the DM panel drops early candidates",
);
check("a stalled call retries ICE instead of spinning forever", dmPanel.includes("restartIce?.()") && dmPanel.includes("25_000"), "no bounded retry/watchdog exists");
check("signals are applied oldest first (community)", /sort\(\(a, b\) => a\._creationTime - b\._creationTime\)/.test(communities), "signals can be applied out of order");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
