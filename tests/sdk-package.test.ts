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

// A minimal ustar writer, so a test can build tarballs `tar` itself would
// never produce: entries hidden behind a lone zero block, and links.
const ustarHeader = (name: string, size: number, type: string, linkname = ""): Buffer => {
  const header = Buffer.alloc(512);
  const field = (value: string, offset: number, length: number): void => {
    header.write(value, offset, Math.min(Buffer.byteLength(value), length), "ascii");
  };
  const octal = (value: number, length: number): string => `${value.toString(8).padStart(length - 1, "0")}\0`;
  field(name, 0, 100);
  field(octal(0o644, 8), 100, 8);
  field(octal(0, 8), 108, 8);
  field(octal(0, 8), 116, 8);
  field(octal(size, 12), 124, 12);
  field(octal(0, 12), 136, 12);
  field("        ", 148, 8);
  field(type, 156, 1);
  field(linkname, 157, 100);
  field("ustar\0", 257, 6);
  field("00", 263, 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  field(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
};
const ustarFile = (name: string, contents: string): Buffer => {
  const data = Buffer.from(contents);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([ustarHeader(name, data.length, "0"), data, padding]);
};
const writeGzip = (parts: Buffer[]): { dir: string; tarball: string } => {
  const dir = mkdtempSync(join(tmpdir(), "synxed-sdk-tarball-test-"));
  const tarball = join(dir, "crafted.tgz");
  writeFileSync(tarball, Bun.gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)])));
  return { dir, tarball };
};

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
    expect(publish).toContain(`const allowedFile = ${String(ALLOWED_PACKAGE_FILE)};`);
    expect(publish).toContain(`const registryRange = ${String(REGISTRY_RANGE)};`);
    const keys = Object.keys(publishManifest(workspace)).sort();
    expect(publish).toContain(`const expectedKeys = ${JSON.stringify(keys)};`);
    expect(publish).toMatch(/^ {8}run: npm stage publish --provenance --access public "\$TARBALL"$/m);
    expect(publish).toContain('tar --ignore-zeros -tzf "$TARBALL"');
    expect(publish).toContain('types.some((type) => type !== "-")');
  });

  test("CI tests the minimum Node version the package declares", () => {
    const engines = publishManifest(workspace).engines;
    const declared =
      typeof engines === "object" && engines !== null && "node" in engines
        ? String(engines.node)
        : "";
    const minimum = /^>=(\d+)\.(\d+)$/.exec(declared);
    expect(minimum).not.toBeNull();
    expect(workflow("ci.yml")).toMatch(
      new RegExp(`^ {10}node-version: "${minimum?.[1]}\\.${minimum?.[2]}\\.0"$`, "m"),
    );
  });
});

// The publish workflow smoke-tests the exact tarball it will stage through
// SYNXED_SDK_TARBALL. These cases fail before any network access.
describe("smoke test against a given tarball", () => {
  const smoke = (env: Record<string, string>): { status: number | null; output: string } => {
    const result = spawnSync(process.execPath, ["run", join(REPO_ROOT, "scripts", "smoke-sdk-package.ts")], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      // Offline, so a broken refusal fails fast instead of installing from
      // the registry; never keep temp dirs from these runs.
      env: { ...process.env, SYNXED_KEEP_SMOKE: "", npm_config_offline: "true", ...env },
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
    // List the files explicitly, so the tarball has no directory entry
    // (npm pack does not write one, and the smoke test refuses it).
    const entries = ["package/package.json", "package/index.js"];
    if (extraFile !== undefined) {
      entries.push(`package/${extraFile}`);
    }
    const tar = spawnSync("tar", ["-czf", tarball, "-C", dir, ...entries]);
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

  const manifest = JSON.stringify({ name: PACKAGE_NAME, version: workspace.version });

  test("sees entries hidden behind a lone zero block, as npm does", () => {
    // A reader that stops at the first zero block sees one package.json and
    // misses the second; npm's reader continues and would publish both.
    const { dir, tarball } = writeGzip([
      ustarFile("package/package.json", manifest),
      Buffer.alloc(512),
      ustarFile("package/package.json", JSON.stringify({ name: PACKAGE_NAME, version: workspace.version, scripts: { postinstall: "evil" } })),
    ]);
    try {
      const result = smoke({ SYNXED_SDK_TARBALL: tarball });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("duplicate entries");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses a symbolic link with an allowlisted name", () => {
    const { dir, tarball } = writeGzip([
      ustarFile("package/package.json", manifest),
      ustarHeader("package/evil.js", 0, "2", "/etc/passwd"),
    ]);
    try {
      const result = smoke({ SYNXED_SDK_TARBALL: tarball });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("not regular files");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses duplicate entries", () => {
    const { dir, tarball } = writeGzip([
      ustarFile("package/package.json", manifest),
      ustarFile("package/index.js", "export {};\n"),
      ustarFile("package/index.js", "export const x = 1;\n"),
    ]);
    try {
      const result = smoke({ SYNXED_SDK_TARBALL: tarball });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("duplicate entries");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses a tarball of another package", () => {
    const { dir, tarball } = writeGzip([
      ustarFile("package/package.json", JSON.stringify({ name: "@coumtech/other", version: workspace.version })),
    ]);
    try {
      const result = smoke({ SYNXED_SDK_TARBALL: tarball });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("@coumtech/other");
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

// The publish job's check runs no repository code, so it is restated inline in
// publish-sdk.yml. This runs that exact script, as the runner would see it,
// against a valid tarball and against tampered ones.
describe("publish job tarball check", () => {
  const checkScript = (): string => {
    const text = readFileSync(join(REPO_ROOT, ".github", "workflows", "publish-sdk.yml"), "utf8");
    const body = text.split(`cat > "$RUNNER_TEMP/check.cjs" <<'CHECK'\n`)[1]?.split("\n          CHECK\n")[0];
    expect(body).toBeDefined();
    return (body ?? "")
      .split("\n")
      .map((line) => (line.startsWith(" ".repeat(10)) ? line.slice(10) : line))
      .join("\n");
  };

  const valid = publishManifest(workspace);
  const targets = ["main", "types"].map((key) => String(valid[key]));
  const exportsField = valid.exports;
  const exportEntries =
    typeof exportsField === "object" && exportsField !== null ? Object.values(exportsField) : [];
  for (const entry of exportEntries) {
    if (typeof entry === "string") {
      targets.push(entry);
    } else if (typeof entry === "object" && entry !== null) {
      targets.push(...Object.values(entry).map(String));
    }
  }
  const shipped = [...new Set(targets.filter((t) => t !== "./package.json").map((t) => t.slice(2)))];

  const runCheck = (
    manifestOverride: Record<string, unknown>,
    extra: Buffer[] = [],
  ): { status: number | null; output: string } => {
    const dir = mkdtempSync(join(tmpdir(), "synxed-publish-check-test-"));
    try {
      const parts = [
        ustarFile("package/package.json", JSON.stringify({ ...valid, ...manifestOverride })),
        ...shipped.map((file) => ustarFile(`package/${file}`, "x\n")),
        ustarFile("package/README.md", "readme\n"),
        ustarFile("package/LICENSE", "license\n"),
        ...extra,
      ];
      const tarball = join(dir, "crafted.tgz");
      writeFileSync(tarball, Bun.gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)])));
      // The same two listings the workflow step writes.
      const entries = spawnSync("tar", ["--ignore-zeros", "-tzf", tarball], { encoding: "utf8" }).stdout;
      const types = spawnSync("tar", ["--ignore-zeros", "-tvzf", tarball], { encoding: "utf8" })
        .stdout.split("\n")
        .filter((line) => line !== "")
        .map((line) => line.charAt(0))
        .join("\n");
      writeFileSync(join(dir, "entries.txt"), entries);
      writeFileSync(join(dir, "types.txt"), `${types}\n`);
      writeFileSync(join(dir, "check.cjs"), checkScript());
      const result = spawnSync(
        "node",
        [join(dir, "check.cjs"), join(dir, "entries.txt"), join(dir, "types.txt"), tarball],
        {
          encoding: "utf8",
          env: { ...process.env, PACKAGE_NAME, VERSION: String(workspace.version) },
        },
      );
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("accepts a tarball that follows the build rules", () => {
    const result = runCheck({});
    expect(result.output).toContain("files checked");
    expect(result.status).toBe(0);
  });

  const refused: ReadonlyArray<readonly [string, Record<string, unknown>, Buffer[], string]> = [
    ["an extra manifest key", { bin: { x: "./index.js" } }, [], "unexpected manifest keys"],
    ["a git dependency", { dependencies: { bs58: "github:someone/bs58" } }, [], "dependencies.bs58"],
    ["a peer dependency URL", { peerDependencies: { "@solana/web3.js": "https://example.test/x.tgz" } }, [], "peerDependencies"],
    ["a main outside the package", { main: "./sub/../index.js" }, [], "bad target"],
    ["another package name", { name: "@coumtech/other" }, [], "name is @coumtech/other"],
    ["a changed publishConfig", { publishConfig: { access: "public", provenance: false } }, [], "unexpected publishConfig"],
    ["a file outside the allowlist", {}, [ustarFile("package/.env", "SECRET=1\n")], "unexpected tarball entry package/.env"],
    ["a duplicate entry", {}, [ustarFile("package/index.js", "y\n")], "duplicate tarball entries"],
    [
      "a manifest hidden behind a lone zero block",
      {},
      [Buffer.alloc(512), ustarFile("package/package.json", JSON.stringify({ scripts: { postinstall: "evil" } }))],
      "duplicate tarball entries",
    ],
    ["a symbolic link", {}, [ustarHeader("package/evil.js", 0, "2", "/etc/passwd")], "not regular files"],
  ];
  for (const [name, override, extra, message] of refused) {
    test(`refuses ${name}`, () => {
      const result = runCheck(override, extra);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain(message);
    });
  }
});
