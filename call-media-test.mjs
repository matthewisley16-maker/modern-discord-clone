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
import { fullscreenElement, fullscreenSupported, isFullscreenElement, viewAfterFullscreen } from "./src/lib/fullscreen";

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

// ---------------------------------------------------------------------------
// 4. Fullscreen: the video is never cut off, and the panels follow the BROWSER
//    (Esc and F11 leave fullscreen without asking us first)
// ---------------------------------------------------------------------------
is("a floating call comes back floating after fullscreen", viewAfterFullscreen("float", false), "float");
is("an expanded call comes back expanded", viewAfterFullscreen("full", false), "full");
is("a minimized call never comes back as a fullscreen window", viewAfterFullscreen("full", true), "compact");
is("with nothing to restore, the floating window is the fallback", viewAfterFullscreen(null, false), "float");
is("fullscreen is honestly unavailable when there is no browser", fullscreenSupported(), false);
is("nothing is fullscreen outside a browser", fullscreenElement(), null);
check("a missing element never counts as fullscreen", isFullscreenElement(null) === false, "null was reported as fullscreen");

const indexCss = read("src", "index.css");
/** Rules with braces (at-rules flattened), so `@media` overrides are seen too. */
function cssRules(sheet, selector) {
  const out = [];
  const clean = sheet.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@[^{]+\{/g, " ");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    if (m[1].split(",").map((s) => s.trim()).includes(selector)) out.push(m[2]);
  }
  return out;
}
/** The last declared value of `prop` for an exact selector (null when absent). */
function cssValue(sheet, selector, prop) {
  const values = cssRules(sheet, selector)
    .map((decls) => decls.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`)))
    .filter(Boolean)
    .map((m) => m[1].trim());
  return values.at(-1) ?? null;
}
check("the DM call window can really fill the screen", cssValue(indexCss, ".fc-callwin:fullscreen", "width") === "100%" && cssValue(indexCss, ".fc-callwin:fullscreen", "height") === "100%", "a fullscreen call window keeps its floating size");
is("the DM video is letterboxed, never cropped, in fullscreen", cssValue(indexCss, ".fc-callwin:fullscreen .fc-callwin-video", "object-fit"), "contain");
is("the DM video is not cropped in the expanded view either", cssValue(indexCss, ".fc-callwin.full .fc-callwin-video", "object-fit"), "contain");
check("the DM video stage fills the fullscreen window", cssValue(indexCss, ".fc-callwin:fullscreen .fc-callwin-remote", "flex") === "1", "the stage keeps its small aspect ratio");
check("the DM call controls stay laid out in fullscreen", cssRules(indexCss, ".fc-callwin:fullscreen .fc-callwin-controls").length > 0, "fullscreen hides the controls");
check("the community panel can fill the screen", cssValue(indexCss, ".vp-panel:fullscreen", "height") === "100%" && cssValue(indexCss, ".vp-panel:fullscreen", "max-height") === "none", "the panel keeps its 90vh cap, so part of the grid is cut off");
is("community video is letterboxed, never cropped, in fullscreen", cssValue(indexCss, ".vp-panel:fullscreen .vp-video", "object-fit"), "contain");
check("community video tiles are not capped at thumbnail size in fullscreen", cssValue(indexCss, ".vp-panel:fullscreen .vp-video", "max-height") === "none" && cssValue(indexCss, ".vp-panel:fullscreen .vp-video", "max-width") === "none", "the 168px thumbnail cap still applies in fullscreen");

check("the DM panel asks the browser for fullscreen", dmPanel.includes("enterFullscreen(el)"), "no fullscreen request exists");
check("the DM panel follows the browser's fullscreen state", dmPanel.includes("onFullscreenChange") && dmPanel.includes("isFullscreenElement(rootRef.current)"), "the panel keeps its own idea of fullscreen");
check("the DM panel restores a real view when fullscreen ends (Esc included)", dmPanel.includes("viewAfterFullscreen(previous, minimizedRef.current)"), "leaving fullscreen can strand the window");
check("the DM panel releases fullscreen when the call is minimized or ends", dmPanel.includes("if (minimized && fullscreenMineRef.current) void exitFullscreen();") && dmPanel.includes("if (fullscreenMineRef.current) void exitFullscreen();"), "a mini window can be left fullscreen/blank");
check("the community panel asks the browser for fullscreen", voicePanel.includes("enterFullscreen(el)"), "no fullscreen request exists");
check("the community panel follows the browser's fullscreen state", voicePanel.includes("onFullscreenChange") && voicePanel.includes("isFullscreenElement(panelRef.current)"), "the panel keeps its own idea of fullscreen");
check("the community panel releases fullscreen when the call ends", voicePanel.includes("if (fullscreenMineRef.current) void exitFullscreen();"), "leaving the call can strand fullscreen");
check("shared screens still fullscreen on their own", dmPanel.includes("toggleScreenFullscreen") && voicePanel.includes("toggleScreenFullscreen"), "the shared-screen fullscreen button was dropped");
check("neither panel hand-rolls the fullscreen API", !/document\.fullscreenElement/.test(dmPanel + voicePanel), "a panel reads the raw API instead of the helpers");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
