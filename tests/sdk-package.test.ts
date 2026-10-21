import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALLOWED_PACKAGE_FILE,
  PACKAGE_NAME,
  REGISTRY_RANGE,
  REPO_ROOT,
  publishManifest,
  readWorkspaceManifest,
} from "../scripts/build-sdk-package.ts";

// The published manifest is generated from sdk/typescript/package.json by
// scripts/build-sdk-package.ts. These tests pin the rules that keep the npm
// package installable and keep the TypeScript sources from being published.
// `bun run smoke:sdk` (run in CI) installs the real tarball end to end.

const workspace = readWorkspaceManifest();

describe("publishManifest", () => {
  test("maps every source export to compiled JS and declarations", () => {
    const manifest = publishManifest(workspace);
    expect(manifest.exports).toEqual({
      ".": { types: "./index.d.ts", default: "./index.js" },
      "./client": { types: "./client.d.ts", default: "./client.js" },
      "./ledger": { types: "./ledger.d.ts", default: "./ledger.js" },
      "./types": { types: "./types.d.ts", default: "./types.js" },
      "./package.json": "./package.json",
    });
    expect(manifest.main).toBe("./index.js");
    expect(manifest.types).toBe("./index.d.ts");
  });

  test("derives main and types from the root export", () => {
    const manifest = publishManifest({
      ...workspace,
      exports: { ".": "./src/client.ts" },
    });
    expect(manifest.main).toBe("./client.js");
    expect(manifest.types).toBe("./client.d.ts");
  });

  test("keeps the published runtime contract", () => {
    const manifest = publishManifest(workspace);
    // Node 22.12 is the first 22.x line where @solana/web3.js's dependency
    // tree loads (require of ES modules); older 22.x releases crash on import.
    expect(manifest.engines).toEqual({ node: ">=22.12" });
    expect(manifest.type).toBe("module");
    expect(manifest.sideEffects).toBe(false);
    expect(manifest.files).toEqual(["*.js", "*.js.map", "*.d.ts", "README.md", "LICENSE"]);
    // TypeScript resolves conditions in order, so "types" must come first.
    const exportsField = manifest.exports;
    expect(typeof exportsField).toBe("object");
    const entries = typeof exportsField === "object" && exportsField !== null ? Object.values(exportsField) : [];
    for (const entry of entries) {
      if (typeof entry === "object" && entry !== null) {
        expect(Object.keys(entry)).toEqual(["types", "default"]);
      }
    }
  });

  test("ships web3.js as a peer dependency only", () => {
    const manifest = publishManifest(workspace);
    expect(manifest.peerDependencies).toEqual({ "@solana/web3.js": "^1.99.0" });
    expect(manifest.dependencies).not.toHaveProperty(["@solana/web3.js"]);
  });

  test("drops workspace-only fields and keeps the publish settings", () => {
    const manifest = publishManifest(workspace);
    expect(manifest.private).toBeUndefined();
    expect(manifest.scripts).toBeUndefined();
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.publishConfig).toEqual({ access: "public", provenance: true });
    expect(manifest.name).toBe(PACKAGE_NAME);
    expect(manifest.version).toBe(workspace.version);
  });

  const rejected: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ["a public workspace package", { ...workspace, private: false }, "private"],
    ["a CommonJS package", { ...workspace, type: "commonjs" }, "module"],
    ["another package name", { ...workspace, name: "@coumtech/other" }, "package name"],
    ["a missing version", { ...workspace, version: undefined }, "release version"],
    ["a prerelease version", { ...workspace, version: "0.2.0-beta.1" }, "release version"],
    ["build metadata", { ...workspace, version: "0.2.0+build.1" }, "release version"],
    ["an export outside src", { ...workspace, exports: { ".": "./dist/index.js" } }, "./src/"],
    ["a parent-directory export", { ...workspace, exports: { ".": "./src/../x.ts" } }, "./src/"],
    ["no root export", { ...workspace, exports: { "./client": "./src/client.ts" } }, '"."'],
    [
      "a dependency that is also a peer",
      { ...workspace, dependencies: { "@solana/web3.js": "^1.99.0" } },
      "both a dependency and a peer",
    ],
    ["a missing publishConfig", { ...workspace, publishConfig: undefined }, "publishConfig"],
    [
      "provenance turned off",
      { ...workspace, publishConfig: { access: "public", provenance: false } },
      "publishConfig must be exactly",
    ],
    [
      "a custom registry",
      {
        ...workspace,
        publishConfig: { access: "public", provenance: true, registry: "https://example.test" },
      },
      "publishConfig must be exactly",
    ],
  ];
  for (const [name, manifest, message] of rejected) {
    test(`rejects ${name}`, () => {
      expect(() => publishManifest(manifest)).toThrow(message);
    });
  }

  // Only plain registry ranges ship. Everything below either bypasses the
  // registry (git, URL, path, alias) or cannot be resolved by npm.
  const badSpecs = [
    "workspace:*",
    "Workspace:*",
    "catalog:",
    "file:../bs58",
    "../bs58",
    "/tmp/bs58",
    "~/bs58",
    "github:someone/bs58",
    "someone/bs58",
    "git+ssh://git@github.com/someone/bs58.git",
    "https://example.test/bs58.tgz",
    "npm:other-package@1.0.0",
    "1.0.0/bs58",
    "*",
    "latest",
    ">=6.0.0",
    "",
  ];
  for (const spec of badSpecs) {
    test(`rejects the dependency spec ${JSON.stringify(spec)}`, () => {
      expect(() =>
        publishManifest({ ...workspace, dependencies: { bs58: spec } }),
      ).toThrow("registry version range");
    });
  }

  for (const spec of badSpecs) {
    test(`rejects the peer dependency spec ${JSON.stringify(spec)}`, () => {
      expect(() =>
        publishManifest({ ...workspace, peerDependencies: { "@solana/web3.js": spec } }),
      ).toThrow("registry version range");
    });
  }

  test("rejects a non-string dependency spec", () => {
    expect(() => publishManifest({ ...workspace, dependencies: { bs58: 6 } })).toThrow(
      "registry version range",
    );
  });

  test("accepts exact, caret, and tilde ranges", () => {
    for (const spec of ["6.0.0", "^6.0.0", "~6.0.0"]) {
      expect(publishManifest({ ...workspace, dependencies: { bs58: spec } }).dependencies).toEqual({
        bs58: spec,
      });
    }
  });
});

describe("ALLOWED_PACKAGE_FILE", () => {
  test("allows compiled output and package metadata", () => {
    for (const file of ["index.js", "index.js.map", "ledger.d.ts", "package.json", "README.md", "LICENSE"]) {
      expect(ALLOWED_PACKAGE_FILE.test(file)).toBe(true);
    }
  });

  test("rejects sources, nested paths, and anything secret-shaped", () => {
    for (const file of ["index.ts", "src/index.js", ".env", "payer.json", "id.json", "tsconfig.json", "index.mjs"]) {
      expect(ALLOWED_PACKAGE_FILE.test(file)).toBe(false);
    }
  });
});

// The publish workflow checks the tarball with literals of its own, because
// its credentialed job runs no repository code. These pin the copies together.
describe("release configuration stays consistent", () => {
  const workflow = (name: string): string =>
    readFileSync(join(REPO_ROOT, ".github", "workflows", name), "utf8");

  test("the publish workflow checks the same package name and publishConfig", () => {
    const publish = workflow("publish-sdk.yml");
    expect(publish).toContain(`PACKAGE_NAME: "${PACKAGE_NAME}"`);
    expect(publish).toContain(
      `JSON.stringify(${"{"} access: "public", provenance: true ${"}"})`,
    );
    expect(JSON.stringify(workspace.publishConfig)).toBe(
      JSON.stringify({ access: "public", provenance: true }),
    );
  });

  test("the publish job restates the build rules exactly", () => {
    const publish = workflow("publish-sdk.yml");
    expect(publish).toContain(`const allowedFile = /${ALLOWED_PACKAGE_FILE.source}/;`);
    expect(publish).toContain(`const registryRange = /${REGISTRY_RANGE.source}/;`);
    const keys = Object.keys(publishManifest(workspace)).sort();
    expect(publish).toContain(`const expectedKeys = ${JSON.stringify(keys)};`);
    expect(publish).toContain('run: npm stage publish --provenance --access public "$TARBALL"');
  });

  test("CI tests the minimum Node version the package declares", () => {
    const engines = publishManifest(workspace).engines;
    const declared =
      typeof engines === "object" && engines !== null && "node" in engines
        ? String(engines.node)
        : "";
    const minimum = /^>=(\d+)\.(\d+)$/.exec(declared);
    expect(minimum).not.toBeNull();
    expect(workflow("ci.yml")).toContain(
      `node-version: "${minimum?.[1]}.${minimum?.[2]}.0"`,
    );
  });
});

// The publish workflow smoke-tests the exact tarball it will stage through
// SYNXED_SDK_TARBALL. These cases fail before any network access.
describe("smoke test against a given tarball", () => {
  const smoke = (env: Record<string, string>): { status: number | null; output: string } => {
    const result = spawnSync("bun", ["run", join(REPO_ROOT, "scripts", "smoke-sdk-package.ts")], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 60_000,
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };

  const craft = (version: string, extraFile?: string): { dir: string; tarball: string } => {
    const dir = mkdtempSync(join(tmpdir(), "synxed-sdk-tarball-test-"));
    mkdirSync(join(dir, "package"));
    writeFileSync(
      join(dir, "package", "package.json"),
      JSON.stringify({ name: PACKAGE_NAME, version }),
    );
    writeFileSync(join(dir, "package", "index.js"), "export {};\n");
    if (extraFile !== undefined) {
      writeFileSync(join(dir, "package", extraFile), "SECRET=1\n");
    }
    const tarball = join(dir, "crafted.tgz");
    const tar = spawnSync("tar", ["-czf", tarball, "-C", dir, "package"]);
    expect(tar.status).toBe(0);
    return { dir, tarball };
  };

  test("refuses an empty SYNXED_SDK_TARBALL", () => {
    const result = smoke({ SYNXED_SDK_TARBALL: "" });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("SYNXED_SDK_TARBALL is set but empty");
  });

  test("refuses a tarball whose version is not this checkout's", () => {
    const { dir, tarball } = craft("9.9.9");
    try {
      const result = smoke({ SYNXED_SDK_TARBALL: tarball });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("but this checkout is");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses a tarball with a file outside the allowlist", () => {
    const { dir, tarball } = craft(String(workspace.version), ".env");
    try {
      const result = smoke({ SYNXED_SDK_TARBALL: tarball });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("unexpected file: .env");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
