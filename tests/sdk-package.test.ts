import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALLOWED_PACKAGE_FILE,
  PACKAGE_NAME,
  REGISTRY_RANGE,
  REPO_ROOT,
  PUBLISH_CHECK_STEP,
  publishCheckScript,
  publishJobStep,
  publishManifest,
  readWorkspaceManifest,
} from "../scripts/build-sdk-package.ts";

// Several tests spawn the smoke script or node; give them room on a loaded
// machine (their own child processes time out at 60 seconds).
setDefaultTimeout(60_000);

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

  test("rejects sources, nested paths, anything secret-shaped, and server.js", () => {
    // npm adds a start script to the manifest of a package that ships server.js.
    for (const file of ["index.ts", "src/index.js", ".env", "payer.json", "id.json", "tsconfig.json", "index.mjs", "server.js"]) {
      expect(ALLOWED_PACKAGE_FILE.test(file)).toBe(false);
    }
  });
});

// A minimal ustar writer, so a test can build tarballs `tar` itself would
// never produce: entries hidden behind a lone zero block, links, and headers
// with a signed checksum.
const ustarHeader = (
  name: string,
  size: number,
  type: string,
  linkname = "",
  signedChecksum = false,
): Buffer => {
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
  // GNU tar and bsdtar also accept a checksum summed over signed bytes; npm's
  // tar reader does not. A high byte in the padding makes the two sums differ.
  if (signedChecksum) {
    header[511] = 0xff;
  }
  const checksum = header.reduce(
    (sum, byte) => sum + (signedChecksum && byte > 127 ? byte - 256 : byte),
    0,
  );
  field(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
};
const ustarFile = (name: string, contents: string | Buffer): Buffer => {
  const data = typeof contents === "string" ? Buffer.from(contents) : contents;
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([ustarHeader(name, data.length, "0"), data, padding]);
};
// An allowlisted file whose header has a signed checksum, so GNU tar reads
// `hidden` as its data while npm's tar reader reads `hidden` as entries.
const signedChecksumFile = (name: string, hidden: Buffer): Buffer =>
  Buffer.concat([ustarHeader(name, hidden.length, "0", "", true), hidden]);
// The directory of the npm on PATH. In CI these tests run under the runner's
// own npm; the publish job runs the same check under the npm its Node pin
// bundles.
const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
if (npmRoot.status !== 0 || npmRoot.error !== undefined) {
  throw new Error(`these tests need npm on PATH: ${npmRoot.error?.message ?? npmRoot.stderr}`);
}
const npmDirectory = join(npmRoot.stdout.trim(), "npm");
const npmTarLibrary = join(npmDirectory, "node_modules", "tar");
const writeGzip = (parts: Buffer[]): { dir: string; tarball: string } => {
  const dir = mkdtempSync(join(tmpdir(), "synxed-sdk-tarball-test-"));
  const tarball = join(dir, "crafted.tgz");
  writeFileSync(tarball, Bun.gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)])));
  return { dir, tarball };
};

// A manifest that follows the build rules, and the files its targets name.
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
    expect(publish).toContain('types.some((type) => type !== "-")');
  });

  // Every shell line of the check step outside the heredoc, exactly: a line
  // added, removed, or wrapped (an early exit, an `if false`) fails here.
  test("the publish job's check step runs exactly these commands", () => {
    const run = publishJobStep(workflow("publish-sdk.yml"), PUBLISH_CHECK_STEP).run;
    expect(typeof run).toBe("string");
    const lines = String(run).split("\n");
    const opener = lines.indexOf(`cat > "$RUNNER_TEMP/check.cjs" <<'CHECK'`);
    const closer = lines.indexOf("CHECK", opener + 1);
    expect(opener).toBeGreaterThan(-1);
    expect(closer).toBeGreaterThan(opener);
    const shell = [...lines.slice(0, opener + 1), ...lines.slice(closer)]
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    expect(shell).toEqual([
      `actual=$(sha256sum "$TARBALL" | cut -d' ' -f1)`,
      `if [ "$actual" != "$EXPECTED" ]; then`,
      `echo "sha256 mismatch: packed $EXPECTED, downloaded $actual"`,
      "exit 1",
      "fi",
      `tar --ignore-zeros -tzf "$TARBALL" > "$RUNNER_TEMP/entries.txt"`,
      `tar --ignore-zeros -tvzf "$TARBALL" | cut -c1 > "$RUNNER_TEMP/types.txt"`,
      `cat > "$RUNNER_TEMP/check.cjs" <<'CHECK'`,
      "CHECK",
      `node "$RUNNER_TEMP/check.cjs" "$RUNNER_TEMP/entries.txt" "$RUNNER_TEMP/types.txt" "$TARBALL" "$(npm root -g)/npm"`,
    ]);
  });

  // An `if`, `continue-on-error`, `shell`, or an extra step would neutralize
  // the check without touching its commands, so the job's shape is pinned.
  test("the publish job's steps and their settings are exactly these", () => {
    const parsed: unknown = Bun.YAML.parse(workflow("publish-sdk.yml"));
    const job: unknown = Reflect.get(Reflect.get(parsed ?? {}, "jobs") ?? {}, "publish");
    expect(Object.keys(job ?? {}).sort()).toEqual([
      "environment", "if", "name", "needs", "permissions", "runs-on", "steps", "timeout-minutes",
    ]);
    const steps: unknown = Reflect.get(job ?? {}, "steps");
    expect(Array.isArray(steps)).toBe(true);
    const shape = (Array.isArray(steps) ? steps : []).map((step: unknown) => [
      String(Reflect.get(step ?? {}, "name")),
      Object.keys(step ?? {}).sort().join(","),
    ]);
    expect(shape).toEqual([
      ["Require main", "name,run"],
      ["Setup Node", "name,uses,with"],
      ["Check npm supports staged trusted publishing", "name,run"],
      ["Download the tarball", "name,uses,with"],
      [PUBLISH_CHECK_STEP, "env,name,run"],
      ["Stage on npm", "env,name,run"],
    ]);
    for (const step of Array.isArray(steps) ? steps : []) {
      expect(String(Reflect.get(step ?? {}, "run") ?? "")).not.toMatch(/GITHUB_ENV|GITHUB_PATH/);
    }
  });

  test("the check script is read from the publish job's step, and only there", () => {
    const real = workflow("publish-sdk.yml");
    expect(publishCheckScript(real)).toContain("const expectedKeys = ");
    // A second heredoc with the same opener, anywhere in the file, is refused.
    const decoy = real.replace(
      "\n  publish:\n",
      `\n  decoy:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: |\n          cat > "$RUNNER_TEMP/check.cjs" <<'CHECK'\n          process.exit(0);\n          CHECK\n  publish:\n`,
    );
    expect(decoy).not.toBe(real);
    expect(() => publishCheckScript(decoy)).toThrow("exactly once");
    // A GitHub expression would be substituted only in the job.
    const expression = real.replace(
      "          const problems = [];\n",
      '          const problems = [];\n          if ("${{ inputs.publish }}" === "true") problems.length = 0;\n',
    );
    expect(expression).not.toBe(real);
    expect(() => publishCheckScript(expression)).toThrow("GitHub expression");
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
    // COPYFILE_DISABLE stops macOS tar from adding "._" metadata entries,
    // which its own listing hides but npm's tar reader sees as files.
    const tar = spawnSync("tar", ["-czf", tarball, "-C", dir, ...entries], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
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

  test("refuses a manifest hidden behind a signed checksum, which only npm reads", () => {
    const hidden = ustarFile(
      "package/package.json",
      JSON.stringify({ name: PACKAGE_NAME, version: workspace.version, scripts: { postinstall: "evil" } }),
    );
    const { dir, tarball } = writeGzip([
      ustarFile("package/package.json", manifest),
      signedChecksumFile("package/zz.js", hidden),
    ]);
    try {
      const result = smoke({ SYNXED_SDK_TARBALL: tarball });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("npm's tar reader refuses the tarball");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses an entry after the end-of-archive marker, which npm never reads", () => {
    const { dir, tarball } = writeGzip([
      ustarFile("package/package.json", manifest),
      Buffer.alloc(1024),
      ustarFile("package/zz.js", "export {};\n"),
    ]);
    try {
      const result = smoke({ SYNXED_SDK_TARBALL: tarball });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("npm's tar reader sees different entries");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runs the publish job's check, so a hand-published dry run meets its rules", () => {
    // Passes the smoke test's own checks (allowlisted files, this checkout's
    // name and version, the required files) but carries a lifecycle script,
    // which only the publish job's manifest rules refuse.
    const { dir, tarball } = writeGzip([
      ustarFile("package/package.json", JSON.stringify({ ...valid, scripts: { postinstall: "evil" } })),
      ...shipped.map((file) => ustarFile(`package/${file}`, "x\n")),
      ustarFile("package/index.js.map", "{}\n"),
      ustarFile("package/README.md", "readme\n"),
      ustarFile("package/LICENSE", "license\n"),
    ]);
    try {
      const result = smoke({ SYNXED_SDK_TARBALL: tarball });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("the publish job's check refuses the tarball");
      expect(result.output).toContain("unexpected manifest keys");
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

  // Runs the check as the job does, without NODE_PATH and with an empty HOME,
  // so no tar library outside npm's directory can be found by accident.
  const runCheck = (
    manifest: Record<string, unknown> | Buffer,
    extra: Buffer[] = [],
    npmDir = npmDirectory,
    leading: Buffer[] = [],
    inspect?: (tarball: string) => void,
    extraEnv: Record<string, string> = {},
  ): { status: number | null; output: string } => {
    const dir = mkdtempSync(join(tmpdir(), "synxed-publish-check-test-"));
    try {
      const manifestBytes = Buffer.isBuffer(manifest)
        ? manifest
        : Buffer.from(JSON.stringify({ ...valid, ...manifest }));
      const parts = [
        ...leading,
        ustarFile("package/package.json", manifestBytes),
        ...shipped.map((file) => ustarFile(`package/${file}`, "x\n")),
        ustarFile("package/README.md", "readme\n"),
        ustarFile("package/LICENSE", "license\n"),
        ...extra,
      ];
      const tarball = join(dir, "crafted.tgz");
      writeFileSync(tarball, Bun.gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)])));
      inspect?.(tarball);
      // The same two listings the workflow step writes.
      const entries = spawnSync("tar", ["--ignore-zeros", "-tzf", tarball], { encoding: "utf8" }).stdout;
      const types = spawnSync("tar", ["--ignore-zeros", "-tvzf", tarball], { encoding: "utf8" })
        .stdout.split("\n")
        .filter((line) => line !== "")
        .map((line) => line.charAt(0))
        .join("\n");
      writeFileSync(join(dir, "entries.txt"), entries);
      writeFileSync(join(dir, "types.txt"), `${types}\n`);
      writeFileSync(join(dir, "check.cjs"), publishCheckScript());
      const home = join(dir, "home");
      mkdirSync(home);
      const { NODE_PATH: _ignored, ...env } = process.env;
      const result = spawnSync(
        "node",
        [join(dir, "check.cjs"), join(dir, "entries.txt"), join(dir, "types.txt"), tarball, npmDir],
        {
          encoding: "utf8",
          env: { ...env, HOME: home, PACKAGE_NAME, VERSION: String(workspace.version), ...extraEnv },
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
    ["server.js, which npm turns into a start script", {}, [ustarFile("package/server.js", "x\n")], "unexpected tarball entry package/server.js"],
    ["a duplicate entry", {}, [ustarFile("package/index.js", "y\n")], "duplicate tarball entries"],
    [
      "a manifest hidden behind a lone zero block",
      {},
      [Buffer.alloc(512), ustarFile("package/package.json", JSON.stringify({ scripts: { postinstall: "evil" } }))],
      "duplicate tarball entries",
    ],
    ["a symbolic link", {}, [ustarHeader("package/evil.js", 0, "2", "/etc/passwd")], "not regular files"],
    [
      "a manifest hidden behind a signed checksum",
      {},
      [signedChecksumFile("package/zz.js", ustarFile("package/package.json", JSON.stringify({ ...valid, scripts: { postinstall: "evil" } })))],
      "npm's tar reader refuses the tarball",
    ],
    [
      "an entry after the end-of-archive marker",
      {},
      [Buffer.alloc(1024), ustarFile("package/zz.js", "x\n")],
      "npm's tar reader sees different entries",
    ],
  ];
  for (const [name, override, extra, message] of refused) {
    test(`refuses ${name}`, () => {
      const result = runCheck(override, extra);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain(message);
    });
  }

  // A stand-in npm directory whose tar library wraps the real one, for
  // differences the crafted tarballs cannot produce. `onentry` maps each real
  // entry to what the stand-in reports.
  // With `nested`, pacote gets its own tar (the stand-in) and the top-level tar
  // is a decoy that reads like the real one, as when pacote nests a copy.
  const standInModule = (onentry: string): string =>
    `const real = require(${JSON.stringify(npmTarLibrary)});
exports.t = (options) => real.t({ ...options, onentry: ${onentry} });
`;
  const withStandIn = (
    onentry: string,
    run: (npmDir: string) => void,
    nested = false,
  ): void => {
    const dir = mkdtempSync(join(tmpdir(), "synxed-npm-tar-stand-in-"));
    try {
      const pacote = join(dir, "node_modules", "pacote");
      mkdirSync(pacote, { recursive: true });
      mkdirSync(join(dir, "node_modules", "tar"));
      if (nested) {
        mkdirSync(join(pacote, "node_modules", "tar"), { recursive: true });
        writeFileSync(join(pacote, "node_modules", "tar", "index.js"), standInModule(onentry));
        writeFileSync(
          join(dir, "node_modules", "tar", "index.js"),
          `module.exports = require(${JSON.stringify(npmTarLibrary)});\n`,
        );
      } else {
        writeFileSync(join(dir, "node_modules", "tar", "index.js"), standInModule(onentry));
      }
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("refuses when npm's tar reader sees a different package.json", () => {
    // One extra byte after every chunk of package.json.
    withStandIn(
      `(entry) => {
  if (entry.path !== "package/package.json") return options.onentry(entry);
  const listeners = [];
  options.onentry({ type: entry.type, path: entry.path, on: (event, fn) => { if (event === "data") listeners.push(fn); } });
  entry.on("data", (chunk) => listeners.forEach((fn) => fn(Buffer.concat([chunk, Buffer.from(" ")]))));
}`,
      (npmDir) => {
        const result = runCheck({}, [], npmDir);
        expect(result.status).not.toBe(0);
        expect(result.output).toContain("npm's tar reader sees a different package.json");
      },
    );
  });

  test("compares package.json as bytes, not as decoded text", () => {
    // 0x80 and 0x81 are both invalid UTF-8 and decode to the same text, so
    // only a byte comparison sees the stand-in's change.
    const manifest = Buffer.from(JSON.stringify({ ...valid, description: "byte-X" }));
    manifest[manifest.indexOf("byte-X") + 5] = 0x80;
    withStandIn(
      `(entry) => {
  if (entry.path !== "package/package.json") return options.onentry(entry);
  const listeners = [];
  options.onentry({ type: entry.type, path: entry.path, on: (event, fn) => { if (event === "data") listeners.push(fn); } });
  entry.on("data", (chunk) => listeners.forEach((fn) => fn(Buffer.from(chunk.map((byte) => (byte === 0x80 ? 0x81 : byte))))));
}`,
      (npmDir) => {
        const result = runCheck(manifest, [], npmDir);
        expect(result.status).not.toBe(0);
        expect(result.output).toContain("npm's tar reader sees a different package.json");
      },
    );
  });

  test("refuses the same number of entries with a different type or path", () => {
    for (const [change, expected] of [
      ["type: entry.path === 'package/LICENSE' ? 'ContiguousFile' : entry.type", "ContiguousFile package/LICENSE"],
      ["path: entry.path === 'package/LICENSE' ? 'package/other.js' : entry.path", "File package/other.js"],
    ] as const) {
      withStandIn(
        `(entry) => options.onentry({ type: entry.type, path: entry.path, on: (...args) => entry.on(...args), ${change} })`,
        (npmDir) => {
          const result = runCheck({}, [], npmDir);
          expect(result.status).not.toBe(0);
          expect(result.output).toContain("npm's tar reader sees different entries");
          expect(result.output).toContain(expected);
        },
      );
    }
  });

  test("reads with the tar pacote nests, not the top-level copy", () => {
    withStandIn(
      "(entry) => options.onentry({ type: entry.path === 'package/LICENSE' ? 'ContiguousFile' : entry.type, path: entry.path, on: (...args) => entry.on(...args) })",
      (npmDir) => {
        const result = runCheck({}, [], npmDir);
        expect(result.status).not.toBe(0);
        expect(result.output).toContain("npm's tar reader sees different entries");
      },
      true,
    );
  });

  test("refuses the same entries in a different order", () => {
    const dir = mkdtempSync(join(tmpdir(), "synxed-npm-tar-stand-in-"));
    try {
      mkdirSync(join(dir, "node_modules", "pacote"), { recursive: true });
      mkdirSync(join(dir, "node_modules", "tar"));
      writeFileSync(
        join(dir, "node_modules", "tar", "index.js"),
        `const real = require(${JSON.stringify(npmTarLibrary)});
exports.t = (options) => {
  const seen = [];
  real.t({ ...options, onentry: (entry) => seen.push({ type: entry.type, path: entry.path }) });
  seen.reverse().forEach((entry) => options.onentry({ ...entry, on: () => {} }));
};
`,
      );
      const result = runCheck({}, [], dir);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("npm's tar reader sees different entries");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses a tar library found outside npm's directory", () => {
    // npm's directory has pacote but no tar; NODE_PATH offers the real one.
    const dir = mkdtempSync(join(tmpdir(), "synxed-npm-without-tar-"));
    try {
      mkdirSync(join(dir, "node_modules", "pacote"), { recursive: true });
      const result = runCheck({}, [], dir, [], undefined, {
        NODE_PATH: join(npmDirectory, "node_modules"),
      });
      expect(result.status).not.toBe(0);
      expect(result.output).not.toContain("files checked");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts a large multi-byte package.json that npm reads in several chunks", () => {
    let chunks = 0;
    const result = runCheck(
      { description: "\u00e9".repeat(20_000) },
      [],
      npmDirectory,
      [ustarFile("package/aaa.js", "x".repeat(20_000))],
      (tarball) => {
        const counted = spawnSync(
          "node",
          [
            "-e",
            `let n = 0; require(process.argv[1]).t({ file: process.argv[2], sync: true, onentry: (e) => { if (e.path === "package/package.json") e.on("data", () => { n += 1; }); } }); console.log(n);`,
            npmTarLibrary,
            tarball,
          ],
          { encoding: "utf8" },
        );
        chunks = Number(counted.stdout.trim());
      },
    );
    expect(chunks).toBeGreaterThan(1);
    expect(result.output).toContain("files checked");
    expect(result.status).toBe(0);
  });

  test("fails closed when npm's tar library cannot be loaded", () => {
    const result = runCheck({}, [], join(tmpdir(), "no-such-npm"));
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain("files checked");
  });
});
