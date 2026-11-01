/**
 * Builds the publishable npm package for the TypeScript SDK into
 * sdk/typescript/dist/package.
 *
 * The workspace package (sdk/typescript/package.json) exports TypeScript
 * sources so the tests and examples in this repository run the code directly.
 * It is marked private so it can never be published as it is. This script
 * compiles the sources to ES modules with type declarations and writes a
 * generated manifest: COPIED_FIELDS, the dependency maps, and publishConfig
 * come from the workspace package after validation; main, types, exports, and
 * files are generated; private, scripts, and devDependencies are dropped.
 *
 * It also exports the rules and helpers the smoke test and the tests share
 * with the publish workflow (`publishCheckScript`).
 *
 * Usage: bun run build:sdk
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dir, "..");
export const SDK_DIR = join(REPO_ROOT, "sdk", "typescript");
export const PACKAGE_DIR = join(SDK_DIR, "dist", "package");

/** The only package this repository publishes. The publish workflow checks it too. */
export const PACKAGE_NAME = "@coumtech/synxed-solana-protocol";

/** The publish job's check step, whose heredoc writes `check.cjs`. */
export const PUBLISH_CHECK_STEP = "Check the sha256, the file names, and the manifest";
const CHECK_OPENER = `cat > "$RUNNER_TEMP/check.cjs" <<'CHECK'`;

/**
 * The publish job's tarball check, `check.cjs`, exactly as the job writes it.
 * Reads the workflow as YAML, takes the `run` block of the publish job's check
 * step, and cuts the heredoc the way bash does: the lines after the opener up
 * to the first line that is exactly `CHECK`. Refuses a workflow:
 * - that is not printable ASCII with LF line endings (GitHub's YAML parser
 *   breaks lines at NEL, LS and PS, where Bun's and JavaScript's do not, and
 *   the raw scan below splits on LF only);
 * - that holds a `$Id$` keyword, which git's `ident` attribute would expand
 *   in a checkout (what the tests read) but not in the committed file (what
 *   the job writes);
 * - where the opener appears more than once;
 * - where any multi-line `run` of the publish job is not a literal (`|`)
 *   block whose raw text matches the parsed value (YAML parsers disagree on
 *   folded blocks and indentation indicators), bound to that step;
 * - or where the check script holds a `${{ }}` expression, which GitHub would
 *   substitute only in the job.
 */
export function publishCheckScript(
  text = readFileSync(join(REPO_ROOT, ".github", "workflows", "publish-sdk.yml"), "utf8"),
): string {
  if (/[^\n\x20-\x7e]/.test(text)) {
    throw new Error("publish-sdk.yml must be printable ASCII with LF line endings");
  }
  if (/\$Id[$:]/.test(text)) {
    throw new Error("publish-sdk.yml must not contain a $Id$ keyword");
  }
  if (text.split(CHECK_OPENER).length !== 2) {
    throw new Error("publish-sdk.yml must write check.cjs exactly once");
  }
  for (const step of publishJobSteps(text)) {
    const name = Reflect.get(step, "name");
    const run = Reflect.get(step, "run");
    if (typeof run === "string" && (run.includes("\n") || name === PUBLISH_CHECK_STEP)) {
      if (typeof name !== "string") {
        throw new Error("every multi-line step of the publish job must have a name");
      }
      assertLiteralRun(text, name, run);
    }
  }
  const run = publishJobStep(text, PUBLISH_CHECK_STEP).run;
  if (typeof run !== "string") {
    throw new Error(`the "${PUBLISH_CHECK_STEP}" step has no run block`);
  }
  const lines = run.split("\n");
  const start = lines.indexOf(CHECK_OPENER);
  const end = lines.indexOf("CHECK", start + 1);
  if (start === -1 || end === -1) {
    throw new Error(`the "${PUBLISH_CHECK_STEP}" step does not write check.cjs`);
  }
  const body = lines.slice(start + 1, end).join("\n");
  if (body.includes("${{")) {
    throw new Error("check.cjs must not contain a GitHub expression");
  }
  return `${body}\n`;
}

const BINDING_MARKER = "# synxed binding marker";

/**
 * Require a publish job step's `run` to be a literal block whose raw text is
 * what YAML reads, and bind the two: a marker line added to that raw block
 * must appear at the end of this step's parsed `run`. A block found in the
 * wrong place (a copy inside another value, or a run key YAML overrides with
 * a later one) does not pass.
 */
function assertLiteralRun(text: string, name: string, run: string): void {
  const raw = rawRunBlock(text, name);
  if (raw.block !== run.replace(/\n+$/, "")) {
    throw new Error(`the "${name}" step's run must be a literal block that parses as written`);
  }
  const lines = text.split("\n");
  lines.splice(raw.end, 0, `${" ".repeat(10)}${BINDING_MARKER}`);
  const marked = publishJobStep(lines.join("\n"), name).run;
  if (typeof marked !== "string" || marked.replace(/\n+$/, "") !== `${raw.block}\n${BINDING_MARKER}`) {
    throw new Error(`the "${name}" step's run block in the file is not the run YAML reads`);
  }
}

/**
 * The text of a publish job step's `run: |` block as it stands in the file:
 * the lines after `run: |`, with the block's ten-space indentation removed,
 * up to the next line indented less, and the line index just after its last
 * line. Only the publish job's own lines are searched, so a step of the same
 * name in another job is not read here. Throws unless the step has exactly
 * one such literal block.
 */
function rawRunBlock(text: string, name: string): { block: string; end: number } {
  const all = text.split("\n");
  const job = all.indexOf("  publish:");
  if (job === -1 || all.indexOf("  publish:", job + 1) !== -1) {
    throw new Error("publish-sdk.yml must have exactly one publish job");
  }
  // A comment line, at any indentation, does not end a job or a step for
  // YAML, so it does not end them here either.
  let jobEnd = job + 1;
  while (jobEnd < all.length && !/^ {0,2}[^\s#]/.test(all[jobEnd])) {
    jobEnd += 1;
  }
  const headers: number[] = [];
  for (let index = job + 1; index < jobEnd; index += 1) {
    if (all[index] === `      - name: ${name}`) {
      headers.push(index);
    }
  }
  if (headers.length !== 1) {
    throw new Error(`the publish job must have exactly one "${name}" step`);
  }
  const header = headers[0];
  let end = header + 1;
  while (
    end < jobEnd &&
    (all[end] === "" || all[end].startsWith("        ") || /^\s*#/.test(all[end]))
  ) {
    end += 1;
  }
  const runs: number[] = [];
  for (let index = header + 1; index < end; index += 1) {
    if (/^ {8}run:/.test(all[index])) {
      runs.push(index);
    }
  }
  if (runs.length !== 1 || all[runs[0]] !== "        run: |") {
    throw new Error(`the "${name}" step's run must be a single literal block (run: |)`);
  }
  let last = runs[0];
  for (let index = runs[0] + 1; index < end; index += 1) {
    if (all[index] !== "" && !all[index].startsWith(" ".repeat(10))) {
      break;
    }
    if (all[index] !== "") {
      last = index;
    }
  }
  const block = all.slice(runs[0] + 1, last + 1).map((line) => line.slice(10));
  return { block: block.join("\n"), end: last + 1 };
}

/** The publish job's steps, from the workflow's YAML. */
function publishJobSteps(workflowText: string): Record<string, unknown>[] {
  const parsed: unknown = Bun.YAML.parse(workflowText);
  const steps: unknown = Reflect.get(Reflect.get(Reflect.get(parsed ?? {}, "jobs") ?? {}, "publish") ?? {}, "steps");
  if (!Array.isArray(steps)) {
    throw new Error("publish-sdk.yml has no publish job steps");
  }
  return steps.filter((step): step is Record<string, unknown> => typeof step === "object" && step !== null);
}

/** A step of the publish job, by name, from the workflow's YAML. */
export function publishJobStep(workflowText: string, name: string): Record<string, unknown> {
  const matches = publishJobSteps(workflowText).filter((step) => Reflect.get(step, "name") === name);
  if (matches.length !== 1) {
    throw new Error(`publish-sdk.yml must have exactly one "${name}" step`);
  }
  return matches[0];
}

/**
 * Files allowed in the published package. Anything else fails the build.
 * `server.js` is excluded because npm adds a `start` script to the manifest
 * of any package that ships one.
 */
export const ALLOWED_PACKAGE_FILE =
  /^(?:(?!server\.js$)[a-z][a-z0-9-]*\.(?:js|js\.map|d\.ts)|package\.json|README\.md|LICENSE)$/;

/** Workspace manifest fields copied verbatim into the published manifest. */
const COPIED_FIELDS = [
  "name",
  "version",
  "description",
  "license",
  "author",
  "homepage",
  "repository",
  "bugs",
  "keywords",
  "type",
  "sideEffects",
  "engines",
] as const;

const EXPORT_SOURCE = /^\.\/src\/([a-z][a-z0-9-]*)\.ts$/;
/** Release versions only: no prerelease tags or build metadata. */
const RELEASE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
/**
 * Dependency specs must be plain registry ranges: exact, caret, or tilde on a
 * full version. Git, URL, path, alias, workspace, and catalog specs are
 * rejected because they bypass the registry or cannot be resolved by npm.
 */
export const REGISTRY_RANGE = /^[\^~]?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const EXPECTED_PUBLISH_CONFIG = JSON.stringify({ access: "public", provenance: true });

type Manifest = Record<string, unknown>;
type ExportEntry = { types: string; default: string } | string;

function fail(message: string): never {
  throw new Error(`build-sdk-package: ${message}`);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${what} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function dependencyMap(value: unknown, what: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [name, spec] of Object.entries(asRecord(value, what))) {
    if (typeof spec !== "string" || !REGISTRY_RANGE.test(spec)) {
      fail(
        `${what}.${name} must be a registry version range such as ^1.2.3, got ${JSON.stringify(spec)}`,
      );
    }
    map[name] = spec;
  }
  return map;
}

export function readWorkspaceManifest(): Manifest {
  const parsed: unknown = JSON.parse(
    readFileSync(join(SDK_DIR, "package.json"), "utf8"),
  );
  return asRecord(parsed, "sdk/typescript/package.json");
}

/** Derive the published manifest from the workspace manifest. Pure. */
export function publishManifest(source: Manifest): Manifest {
  if (source.private !== true) {
    fail(
      'the workspace package must keep "private": true so its TypeScript sources are never published directly',
    );
  }
  if (source.type !== "module") {
    fail('the package must be "type": "module"');
  }
  if (source.name !== PACKAGE_NAME) {
    fail(`the package name must be ${PACKAGE_NAME}, got ${JSON.stringify(source.name)}`);
  }
  if (typeof source.version !== "string" || !RELEASE_VERSION.test(source.version)) {
    fail(`the version must be a release version such as 1.2.3, got ${JSON.stringify(source.version)}`);
  }

  const manifest: Manifest = {};
  for (const field of COPIED_FIELDS) {
    if (source[field] === undefined) {
      fail(`sdk/typescript/package.json is missing "${field}"`);
    }
    manifest[field] = source[field];
  }

  const exportsOut: Record<string, ExportEntry> = {};
  for (const [subpath, target] of Object.entries(asRecord(source.exports, "exports"))) {
    const match = typeof target === "string" ? EXPORT_SOURCE.exec(target) : null;
    const module = match?.[1];
    if (module === undefined) {
      fail(`export "${subpath}" must point at ./src/<module>.ts, got ${JSON.stringify(target)}`);
    }
    exportsOut[subpath] = { types: `./${module}.d.ts`, default: `./${module}.js` };
  }
  const root = exportsOut["."];
  if (root === undefined || typeof root === "string") {
    fail('exports must include "."');
  }
  exportsOut["./package.json"] = "./package.json";

  const dependencies = dependencyMap(source.dependencies, "dependencies");
  const peerDependencies = dependencyMap(source.peerDependencies, "peerDependencies");
  for (const name of Object.keys(peerDependencies)) {
    if (name in dependencies) {
      fail(`${name} is both a dependency and a peer dependency`);
    }
  }
  const publishConfig = asRecord(source.publishConfig, "publishConfig");
  if (JSON.stringify(publishConfig) !== EXPECTED_PUBLISH_CONFIG) {
    fail(`publishConfig must be exactly ${EXPECTED_PUBLISH_CONFIG}`);
  }

  manifest.main = root.default;
  manifest.types = root.types;
  manifest.exports = exportsOut;
  manifest.files = ["*.js", "*.js.map", "*.d.ts", "README.md", "LICENSE"];
  manifest.dependencies = dependencies;
  manifest.peerDependencies = peerDependencies;
  manifest.publishConfig = publishConfig;
  return manifest;
}

/** Every path the manifest points at: main, types, and each export target. */
function manifestTargets(manifest: Manifest): string[] {
  const targets: unknown[] = [manifest.main, manifest.types];
  for (const entry of Object.values(asRecord(manifest.exports, "exports"))) {
    targets.push(...(typeof entry === "string" ? [entry] : Object.values(asRecord(entry, "export"))));
  }
  return targets.map((target) =>
    typeof target === "string" ? target : fail(`manifest target ${String(target)} is not a path`),
  );
}

/** Compile, assemble, and check sdk/typescript/dist/package. */
export function buildSdkPackage(): Manifest {
  const manifest = publishManifest(readWorkspaceManifest());

  rmSync(PACKAGE_DIR, { recursive: true, force: true });
  // The installed compiler, not `bunx`: the release path must never fetch
  // anything from the registry.
  const tsc = spawnSync(
    join(REPO_ROOT, "node_modules", ".bin", "tsc"),
    ["-p", join(SDK_DIR, "tsconfig.build.json")],
    { cwd: REPO_ROOT, stdio: "inherit", timeout: 10 * 60 * 1000 },
  );
  if (tsc.status !== 0) {
    fail(`tsc failed: ${tsc.error?.message ?? `exit ${tsc.status ?? tsc.signal ?? "unknown"}`}`);
  }

  copyFileSync(join(SDK_DIR, "README.md"), join(PACKAGE_DIR, "README.md"));
  copyFileSync(join(REPO_ROOT, "LICENSE"), join(PACKAGE_DIR, "LICENSE"));
  writeFileSync(
    join(PACKAGE_DIR, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  for (const target of manifestTargets(manifest)) {
    if (!existsSync(join(PACKAGE_DIR, target))) {
      fail(`manifest target ${target} was not produced`);
    }
  }
  for (const entry of readdirSync(PACKAGE_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !ALLOWED_PACKAGE_FILE.test(entry.name)) {
      fail(`unexpected ${entry.isFile() ? "file" : "entry"} in the package: ${entry.name}`);
    }
  }
  return manifest;
}

if (import.meta.main) {
  const manifest = buildSdkPackage();
  console.log(
    `built ${String(manifest.name)}@${String(manifest.version)} in ${relative(REPO_ROOT, PACKAGE_DIR)}`,
  );
}
