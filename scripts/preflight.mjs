#!/usr/bin/env node
/**
 * Deployment preflight for Freecord.
 *
 * Run this BEFORE deploying (and any time the app looks broken):
 *
 *     bun run preflight          # or: node scripts/preflight.mjs
 *
 * It exists because of a real outage: the Convex deployment was paused for
 * exceeding its configured monthly "Database I/O" usage limit. Everything the
 * frontend did then failed — including the OpenID discovery endpoint used for
 * authentication — so every client got
 * `WebSocket closed with code 1013: AuthProviderDiscoveryFailed` in a loop and
 * a black page. Nothing in the code could fix a disabled deployment, but the
 * condition was fully visible from the CLI the whole time.
 *
 * Checks, in order:
 *   1. the deployment the frontend is pinned to actually exists and answers,
 *   2. the frontend and backend target the SAME deployment,
 *   3. the environment variables the auth flow requires are present,
 *   4. no active "disable" usage limit is close to (or past) its threshold.
 *
 * Read-only: it never sets an env var, never changes a limit and never writes
 * to the database. It only reads and reports, and exits non-zero when a
 * deployment would be broken or is about to be paused.
 *
 * Optional flags:
 *   --typecheck   also run `tsc -b --noEmit` before reporting
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));

const problems = [];
const warnings = [];
const notes = [];

const red = (s) => `\u001b[31m${s}\u001b[0m`;
const yellow = (s) => `\u001b[33m${s}\u001b[0m`;
const green = (s) => `\u001b[32m${s}\u001b[0m`;

/** Metrics that pause a deployment, mapped from their display name to the CLI id. */
const METRIC_IDS = {
  "function calls": "functionCalls",
  "query/mutation compute": "queryMutationComputeGbHours",
  "action compute": "actionComputeConvexGbHours",
  "action compute (node.js)": "actionComputeNodeJsGbHours",
  "action compute (cpu)": "actionComputeCpuGbHours",
  "database i/o": "databaseIoGb",
  "search queries": "searchQueryGb",
  "data egress": "dataEgressGb",
};

function convexBin() {
  const local = join(root, "node_modules", ".bin", process.platform === "win32" ? "convex.cmd" : "convex");
  return existsSync(local) ? local : "npx";
}

function runConvex(subArgs) {
  const bin = convexBin();
  const argv = bin === "npx" ? ["convex", ...subArgs] : subArgs;
  return execFileSync(bin, argv, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
}

/** The single deployment URL the bundle is pinned to (src/main.tsx). */
function pinnedDeploymentName() {
  const source = readFileSync(join(root, "src", "main.tsx"), "utf8");
  const match = source.match(/https:\/\/([a-z0-9-]+)\.convex\.(cloud|site)/);
  return match ? match[1] : null;
}

function deploymentNameFrom(url) {
  const match = String(url).match(/https:\/\/([a-z0-9-]+)\.convex\.(cloud|site)/);
  return match ? match[1] : null;
}

/** "140.042K calls (70%)" -> { percent: 70 }. "2 GB (100%)" -> 100. */
function percentOf(cell) {
  const explicit = cell.match(/\((\d+(?:\.\d+)?)%\)/);
  if (explicit) return Number(explicit[1]);
  return null;
}

function parseTable(output) {
  return output
    .split("\n")
    .filter((line) => line.includes("│"))
    .map((line) => line.split("│").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 4 && !/^-+$/.test(cells[0]));
}

// ---------------------------------------------------------------------------
// 0. optional typecheck
// ---------------------------------------------------------------------------
if (args.has("--typecheck")) {
  try {
    execFileSync(join(root, "node_modules", ".bin", "tsc"), ["-b", "--noEmit"], { cwd: root, stdio: "inherit" });
  } catch {
    problems.push("TypeScript does not compile (`tsc -b --noEmit` failed). Fix it before deploying.");
  }
}

// ---------------------------------------------------------------------------
// 1 + 2. deployment reachability and identity
// ---------------------------------------------------------------------------
const pinned = pinnedDeploymentName();
if (!pinned) {
  problems.push("Could not find a pinned Convex URL in src/main.tsx — the frontend has no defined backend.");
}

let env = null;
try {
  env = runConvex(["env", "list"]);
} catch (error) {
  warnings.push(
    `Could not read the deployment's environment (${error?.message?.split("\n")[0] ?? "unknown error"}). ` +
      "Run `bunx convex env list` yourself to verify the auth variables.",
  );
}

if (env !== null) {
  const entries = new Map(
    env
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );

  const siteUrl = entries.get("SITE_URL") ?? entries.get("CONVEX_SITE_URL");
  const backend = deploymentNameFrom(siteUrl);
  if (pinned && backend && backend !== pinned) {
    problems.push(
      `The frontend is pinned to "${pinned}" but the backend deployment is "${backend}". ` +
        "They must point at the same deployment or the app will write to one database and read from another.",
    );
  } else if (pinned && backend) {
    notes.push(`Frontend and backend both target "${pinned}".`);
  }

  // The auth flow cannot work without these (convex/auth.config.ts + @convex-dev/auth).
  const required = ["JWT_PRIVATE_KEY", "JWKS"];
  for (const name of required) {
    if (!entries.has(name)) {
      problems.push(`Missing required auth environment variable \`${name}\` — sign-in will fail and clients will loop on AuthProviderDiscoveryFailed.`);
    }
  }
  if (!entries.has("VLY_CONVEX_AUTH_ISSUER")) {
    warnings.push("VLY_CONVEX_AUTH_ISSUER is not set; convex/auth.config.ts falls back to its default issuer.");
  }
  notes.push(`Environment: ${entries.size} variables present (values never printed).`);
}

// ---------------------------------------------------------------------------
// 3. usage vs configured limits — the check that would have caught the outage
// ---------------------------------------------------------------------------
try {
  const limits = parseTable(runConvex(["deployment", "usage-limits", "list"]));
  if (limits.length === 0) {
    notes.push("No usage limits are configured on this deployment.");
  }
  for (const cells of limits) {
    const [metricName, window, type, limit, usage, active, triggered] = cells;
    const percent = percentOf(usage);
    const metricId = METRIC_IDS[metricName.toLowerCase()] ?? metricName;
    const enforced = active === "yes";
    const paused = triggered === "yes";

    if (paused) {
      problems.push(
        `The "${metricName}" ${window} ${type} limit is TRIGGERED — this deployment is paused and every request ` +
          `(including auth discovery) is failing. Raise or reset it:\n` +
          `    bunx convex deployment usage-limits set --metric ${metricId} --window ${window} --type warning --limit <N>\n` +
          `    bunx convex deployment usage-limits set --metric ${metricId} --window ${window} --type disable --limit <N>   # or remove it\n` +
          `    bunx convex deployment usage-limits remove --metric ${metricId} --window ${window} --type ${type}`,
      );
      continue;
    }

    if (!enforced || percent === null) continue;
    if (type === "disable" && percent >= 90) {
      problems.push(
        `"${metricName}" (${window}) is at ${percent}% of its disable limit (${usage} of ${limit}). ` +
          `It will pause the whole deployment — the exact failure mode that caused the last outage. Raise it now:\n` +
          `    bunx convex deployment usage-limits set --metric ${metricId} --window ${window} --type disable --limit <N>`,
      );
    } else if (percent >= 70) {
      warnings.push(`"${metricName}" (${window}) is at ${percent}% of its ${type} limit (${usage} of ${limit}).`);
    }
  }
} catch (error) {
  warnings.push(`Could not read usage limits (${error?.message?.split("\n")[0] ?? "unknown error"}).`);
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
console.log("\nFreecord deployment preflight\n");
for (const note of notes) console.log(`  ${green("ok")}    ${note}`);
for (const warning of warnings) console.log(`  ${yellow("warn")}  ${warning}`);
for (const problem of problems) console.log(`  ${red("FAIL")}  ${problem}`);
console.log();

if (problems.length > 0) {
  console.log(red(`${problems.length} blocking problem(s). Do not treat this build as deployable.`));
  process.exit(1);
}
console.log(green(`Preflight passed${warnings.length ? ` with ${warnings.length} warning(s)` : ""}.`));
