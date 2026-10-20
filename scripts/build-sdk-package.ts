/**
 * Builds the publishable npm package for the TypeScript SDK into
 * sdk/typescript/dist/package.
 *
 * The workspace package (sdk/typescript/package.json) exports TypeScript
 * sources so the tests and examples in this repository run the code directly.
 * It is marked private so it can never be published as it is. This script
 * compiles the sources to ES modules with type declarations and writes a
 * generated manifest whose exports point at the compiled files. Every other
 * manifest field is copied from the workspace package, which stays the single
 * source of truth for the name, version, and dependencies.
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
const LOCAL_SPEC = /^(?:workspace|file|link|portal):/;

type Manifest = Record<string, unknown>;

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
    if (typeof spec !== "string" || spec === "") {
      fail(`${what}.${name} must be a version range`);
    }
    if (LOCAL_SPEC.test(spec)) {
      fail(`${what}.${name} uses a local protocol (${spec}) that npm cannot resolve`);
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

  const manifest: Manifest = {};
  for (const field of COPIED_FIELDS) {
    if (source[field] === undefined) {
      fail(`sdk/typescript/package.json is missing "${field}"`);
    }
    manifest[field] = source[field];
  }

  const exportsOut: Record<string, unknown> = {};
  for (const [subpath, target] of Object.entries(asRecord(source.exports, "exports"))) {
    const match = typeof target === "string" ? EXPORT_SOURCE.exec(target) : null;
    const module = match?.[1];
    if (module === undefined) {
      fail(`export "${subpath}" must point at ./src/<module>.ts, got ${JSON.stringify(target)}`);
    }
    exportsOut[subpath] = { types: `./${module}.d.ts`, default: `./${module}.js` };
  }
  if (exportsOut["."] === undefined) {
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

  manifest.main = "./index.js";
  manifest.types = "./index.d.ts";
  manifest.exports = exportsOut;
  manifest.files = ["*.js", "*.js.map", "*.d.ts", "README.md", "LICENSE"];
  manifest.dependencies = dependencies;
  manifest.peerDependencies = peerDependencies;
  manifest.publishConfig = asRecord(source.publishConfig, "publishConfig");
  return manifest;
}

/** Compile, assemble, and check sdk/typescript/dist/package. */
export function buildSdkPackage(): Manifest {
  const manifest = publishManifest(readWorkspaceManifest());

  rmSync(PACKAGE_DIR, { recursive: true, force: true });
  const tsc = spawnSync(
    "bunx",
    ["tsc", "-p", join(SDK_DIR, "tsconfig.build.json")],
    { cwd: REPO_ROOT, stdio: "inherit" },
  );
  if (tsc.status !== 0) {
    fail(`tsc exited with ${tsc.status ?? tsc.signal ?? "an unknown status"}`);
  }

  copyFileSync(join(SDK_DIR, "README.md"), join(PACKAGE_DIR, "README.md"));
  copyFileSync(join(REPO_ROOT, "LICENSE"), join(PACKAGE_DIR, "LICENSE"));
  writeFileSync(
    join(PACKAGE_DIR, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  for (const entry of Object.values(asRecord(manifest.exports, "exports"))) {
    const targets = typeof entry === "string" ? [entry] : Object.values(asRecord(entry, "export"));
    for (const target of targets) {
      if (typeof target !== "string" || !existsSync(join(PACKAGE_DIR, target))) {
        fail(`export target ${String(target)} was not produced`);
      }
    }
  }
  for (const file of readdirSync(PACKAGE_DIR)) {
    if (!ALLOWED_PACKAGE_FILE.test(file)) {
      fail(`unexpected file in the package: ${file}`);
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
