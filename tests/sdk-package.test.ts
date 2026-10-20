import { describe, expect, test } from "bun:test";
import {
  ALLOWED_PACKAGE_FILE,
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

  test("ships web3.js as a peer dependency only", () => {
    const manifest = publishManifest(workspace);
    expect(manifest.peerDependencies).toEqual({ "@solana/web3.js": "^1.99.0" });
    expect(Object.keys(manifest.dependencies as Record<string, string>)).not.toContain(
      "@solana/web3.js",
    );
  });

  test("drops workspace-only fields and keeps the publish settings", () => {
    const manifest = publishManifest(workspace);
    expect(manifest.private).toBeUndefined();
    expect(manifest.scripts).toBeUndefined();
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.publishConfig).toEqual({ access: "public", provenance: true });
    expect(manifest.name).toBe("@coumtech/synxed-solana-protocol");
    expect(manifest.version).toBe(workspace.version);
  });

  const rejected: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ["a public workspace package", { ...workspace, private: false }, "private"],
    ["a CommonJS package", { ...workspace, type: "commonjs" }, "module"],
    ["a missing version", { ...workspace, version: undefined }, "version"],
    ["an export outside src", { ...workspace, exports: { ".": "./dist/index.js" } }, "./src/"],
    ["no root export", { ...workspace, exports: { "./client": "./src/client.ts" } }, '"."'],
    [
      "a workspace dependency",
      { ...workspace, dependencies: { bs58: "workspace:*" } },
      "local protocol",
    ],
    [
      "a dependency that is also a peer",
      { ...workspace, dependencies: { "@solana/web3.js": "^1.99.0" } },
      "both a dependency and a peer",
    ],
  ];
  for (const [name, manifest, message] of rejected) {
    test(`rejects ${name}`, () => {
      expect(() => publishManifest(manifest)).toThrow(message);
    });
  }
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
