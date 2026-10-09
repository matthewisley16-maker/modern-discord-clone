/**
 * The ONE Convex deployment Freecord talks to.
 *
 * Dev, preview and the deployed website all read and write this deployment, so
 * there is exactly one place to change it and exactly one place to read it from.
 * `src/main.tsx` builds the client from it, and `src/lib/diagnostics.ts` reports
 * it so an operational problem can name the affected deployment without a
 * network request.
 *
 * NOTE (dev/production separation): because this project currently has a single
 * deployment, development traffic (the sandbox `convex dev` process and the
 * preview app) is counted against the SAME usage limits as the deployed site —
 * a development spike can pause production. `scripts/preflight.mjs` checks the
 * frontend/backend deployment identity and the configured usage limits before a
 * deploy; if separate dev/prod deployments are ever created, point the develop
 * environment at the dev one here and keep the deployed build on this value.
 */
export const CONVEX_URL = "https://academic-porcupine-929.convex.cloud";

/** Short deployment name ("academic-porcupine-929") — safe to display. */
export const DEPLOYMENT_NAME = CONVEX_URL.replace(/^https?:\/\//, "").replace(/\.convex\.(cloud|site).*$/, "");
