/**
 * ICE configuration for every WebRTC call in Freecord (DM calls and community
 * voice/video channels). One module, so all three call surfaces negotiate
 * against exactly the same servers.
 *
 * WHY THIS EXISTS
 * ---------------
 * STUN alone can only discover a device's public address. Two peers that are both
 * behind a "hard" NAT (mobile data, many corporate and hotel Wi-Fi networks,
 * carrier-grade NAT) have no reachable path at all, and the call then sits on
 * "Connecting…" forever with no audio in either direction. A TURN relay is the
 * only way across those networks.
 *
 * TURN credentials are optional and read from the environment, so a deployment
 * that has a relay gets one and a deployment that does not keeps working exactly
 * as before (direct connections, plus several public STUN servers for
 * redundancy). Set these in the project's Keys/API keys tab:
 *
 *   VITE_TURN_URLS        one or more `turn:` / `turns:` URLs, comma separated
 *   VITE_TURN_USERNAME    the relay username
 *   VITE_TURN_CREDENTIAL  the relay password / credential
 *
 * Nothing here is secret in any meaningful sense (a TURN credential is a
 * short-lived relay password), and no media is ever routed through Freecord:
 * with a relay it is forwarded, without one it stays peer-to-peer.
 */

/** The environment shape this module reads (Vite's `import.meta.env`). */
export type IceEnv = Record<string, string | undefined>;

/** Public STUN servers — several, so one being unreachable is not fatal. */
export const DEFAULT_STUN_URLS: readonly string[] = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
  "stun:stun.cloudflare.com:3478",
];

/** Split a comma/whitespace separated URL list, keeping only TURN URLs. */
export function turnUrls(raw: string | undefined | null): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(/[\s,]+/)
    .map((url) => url.trim())
    .filter((url) => /^turns?:/i.test(url));
}

/** The optional TURN relay, or an empty list when none is configured. */
export function turnServers(env: IceEnv): RTCIceServer[] {
  const urls = turnUrls(env.VITE_TURN_URLS ?? env.VITE_TURN_URL);
  if (urls.length === 0) return [];
  const server: RTCIceServer = { urls };
  const username = env.VITE_TURN_USERNAME?.trim();
  const credential = env.VITE_TURN_CREDENTIAL?.trim();
  if (username) server.username = username;
  if (credential) server.credential = credential;
  return [server];
}

/** Is a relay configured? (Drives the wording of a failed-connection message.) */
export function hasRelay(env: IceEnv): boolean {
  return turnServers(env).length > 0;
}

/** Every ICE server a call should use, STUN first then the optional relay. */
export function iceServers(env: IceEnv): RTCIceServer[] {
  return [{ urls: [...DEFAULT_STUN_URLS] }, ...turnServers(env)];
}

/**
 * The full `RTCConfiguration` for one peer connection.
 *
 * `iceCandidatePoolSize` pre-gathers candidates so the first offer already
 * carries usable ones (a faster connect on the common case), and bundling keeps
 * a call to a single transport.
 */
export function rtcConfiguration(env: IceEnv): RTCConfiguration {
  return {
    iceServers: iceServers(env),
    iceCandidatePoolSize: 10,
    bundlePolicy: "max-bundle",
  };
}

/** Vite's build-time environment, or an empty object outside the browser. */
function viteEnv(): IceEnv {
  try {
    return (import.meta as unknown as { env?: IceEnv }).env ?? {};
  } catch {
    return {};
  }
}

/** The configuration every call uses (STUN always, TURN when configured). */
export const RTC_CONFIGURATION: RTCConfiguration = rtcConfiguration(viteEnv());

/** True when this deployment has a relay available for hard NATs. */
export const RELAY_CONFIGURED: boolean = hasRelay(viteEnv());

/**
 * The message shown when media never connects.
 *
 * With a relay configured a fresh attempt usually helps (the relay may have been
 * momentarily unreachable); without one the honest explanation is that the
 * network blocks peer-to-peer audio — which is what a TURN relay is for.
 */
export function connectionFailureMessage(relayConfigured: boolean): string {
  return relayConfigured
    ? "Couldn't connect the call. Leave and rejoin to try the relay again."
    : "Couldn't connect the call — this network blocks direct connections, so a TURN relay is needed.";
}
