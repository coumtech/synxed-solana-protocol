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

/** Files allowed in the published package. Anything else fails the build. */
export const ALLOWED_PACKAGE_FILE =
  /^(?:[a-z][a-z0-9-]*\.(?:js|js\.map|d\.ts)|package\.json|README\.md|LICENSE)$/;

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
  const tsc = spawnSync(
    "bunx",
    ["tsc", "-p", join(SDK_DIR, "tsconfig.build.json")],
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
