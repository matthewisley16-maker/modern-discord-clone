/**
 * Freecord test-suite deployment guard.
 *
 * WHY THIS EXISTS
 * ---------------
 * The root `*-test.mjs` suites create throwaway accounts through the real
 * password sign-up path (`api.auth.signIn`, flow `signUp`) using generated
 * usernames of the form `<label>_<stamp>`. Development and production share one
 * Convex deployment, so running a suite against that deployment leaked ~814
 * synthetic accounts into the production `users` table, where they showed up in
 * the Admin Panel.
 *
 * RULE: TEST/DEMO DATA MUST NEVER BE CREATED IN PRODUCTION.
 *
 * This guard FAILS CLOSED. A suite may only write synthetic accounts when the
 * target deployment is *positively identified* as a throwaway environment:
 *
 *   - a local deployment (localhost / 127.0.0.1 / 0.0.0.0), or
 *   - a remote deployment that is NOT a known production deployment AND has
 *     `FREECORD_TEST_ENV` set to test/development/staging/ci.
 *
 * Anything else — including the shared production deployment — refuses to run
 * and exits non-zero BEFORE any account is created. An ambiguous target is
 * treated as production (fail closed).
 *
 * The only escape hatch is an explicit, deliberate opt-in:
 * `FREECORD_ALLOW_SYNTHETIC_USERS=1`. It prints a loud warning, because the
 * accounts it creates must be purged afterwards via
 * `internal.maintenance.purgeSyntheticUsers`.
 */

/** Deployments used by real, human Freecord accounts. Never write test data here. */
const PRODUCTION_DEPLOYMENT_URLS = new Set([
  "https://academic-porcupine-929.convex.cloud",
]);

/** Values of FREECORD_TEST_ENV that positively mark a throwaway environment. */
const SAFE_ENVIRONMENTS = new Set(["test", "testing", "ci", "development", "dev", "staging"]);

/** Local-only hosts are always safe to write synthetic data to. */
const LOCAL_HOST = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i;

const OVERRIDE_ENV = "FREECORD_ALLOW_SYNTHETIC_USERS";
const ENVIRONMENT_ENV = "FREECORD_TEST_ENV";

/**
 * Resolve the deployment URL a suite should use, refusing to continue when the
 * target is (or cannot be proven to not be) production.
 *
 * @param {string} defaultUrl The URL the suite would otherwise use.
 * @returns {string} The deployment URL to connect to.
 */
export function guardedDeploymentUrl(defaultUrl) {
  const target = String(process.env.CONVEX_URL || process.env.VITE_CONVEX_URL || defaultUrl || "")
    .trim()
    .replace(/\/+$/, "");
  const environment = String(process.env[ENVIRONMENT_ENV] || "").trim().toLowerCase();
  const override = process.env[OVERRIDE_ENV] === "1";

  // Positive proof of a safe environment → allow.
  if (LOCAL_HOST.test(target)) return target;
  if (SAFE_ENVIRONMENTS.has(environment) && !PRODUCTION_DEPLOYMENT_URLS.has(target)) return target;

  // Deliberate opt-in → allow, but warn loudly.
  if (override) {
    console.warn(
      [
        "",
        "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
        "!!  WARNING: creating SYNTHETIC TEST USERS on a deployment that is not ",
        "!!  positively identified as a throwaway environment.                 ",
        `!!  Target: ${target}`,
        "!!                                                                     ",
        "!!  These accounts MUST be cleaned up afterwards with:                 ",
        "!!    internal.maintenance.purgeSyntheticUsers                         ",
        "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
        "",
      ].join("\n"),
    );
    return target;
  }

  console.error(
    [
      "",
      "========================================================================",
      "REFUSING TO RUN: this suite creates synthetic test accounts, and the",
      "target deployment is not a proven test environment.",
      "",
      `  target:      ${target}`,
      `  environment: ${environment || "(unset)"}`,
      "",
      "Test/demo data must never be created against production.",
      "",
      "To run against a throwaway deployment, either:",
      "  - point at a local deployment, or",
      `  - set FREECORD_TEST_ENV=test on a NON-production deployment.`,
      "",
      `To deliberately write test users anyway (they must be purged after):`,
      `  ${OVERRIDE_ENV}=1 <command>`,
      "========================================================================",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
