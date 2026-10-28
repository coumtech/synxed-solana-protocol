import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
// machine. Their own child processes time out at 60 seconds, so a hung child
// reports its own error before the test itself times out.
setDefaultTimeout(90_000);

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

  // Any change to the publish job (an `if`, `continue-on-error`, an env
  // variable such as NODE_OPTIONS, a line in another step, a missing `needs`)
  // could neutralize the check, so the whole job is pinned. The check script
  // itself is replaced by a placeholder here; the tests below run it. This
  // includes the action SHAs: a Dependabot bump of setup-node or
  // download-artifact fails here until a person updates the pin, which is the
  // review the credentialed job deserves.
  test("the publish job is exactly this", () => {
    const parsed: unknown = Bun.YAML.parse(workflow("publish-sdk.yml"));
    expect(Object.keys(parsed ?? {}).sort()).toEqual(["concurrency", "env", "jobs", "name", "on", "permissions"]);
    expect(Reflect.get(parsed ?? {}, "env")).toEqual({
      PACKAGE_NAME,
      NODE_VERSION: "24.22.0",
    });
    const job = JSON.parse(JSON.stringify(Reflect.get(Reflect.get(parsed ?? {}, "jobs") ?? {}, "publish")));
    for (const step of job.steps) {
      if (step.name === PUBLISH_CHECK_STEP) {
        step.run = step.run.replace(publishCheckScript(), "<check.cjs>\n");
      }
    }
    expect(job).toEqual({
      "name": "publish",
      "needs": [
        "package",
        "verify"
      ],
      "if": "${{ inputs.publish }}",
      "runs-on": "ubuntu-24.04",
      "timeout-minutes": 10,
      "environment": "npm-publish",
      "permissions": {
        "contents": "read",
        "id-token": "write"
      },
      "steps": [
        {
          "name": "Require main",
          "run": "if [ \"$GITHUB_REF\" != \"refs/heads/main\" ]; then\n  echo \"Releases are only allowed from main (this run is on $GITHUB_REF).\"\n  exit 1\nfi\n"
        },
        {
          "name": "Setup Node",
          "uses": "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
          "with": {
            "node-version": "${{ env.NODE_VERSION }}",
            "package-manager-cache": false,
            "registry-url": "https://registry.npmjs.org"
          }
        },
        {
          "name": "Check npm supports staged trusted publishing",
          "run": "npm --version\nnode -e 'const [a, b] = process.argv[1].split(\".\").map(Number); if (a < 11 || (a === 11 && b < 15)) { console.error(\"npm 11.15.0 or later is required for npm stage\"); process.exit(1); }' \"$(npm --version)\"\n"
        },
        {
          "name": "Download the tarball",
          "uses": "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333",
          "with": {
            "name": "sdk-tarball",
            "path": "${{ runner.temp }}/sdk-tarball"
          }
        },
        {
          "name": "Check the sha256, the file names, and the manifest",
          "env": {
            "TARBALL": "${{ runner.temp }}/sdk-tarball/${{ needs.package.outputs.tarball }}",
            "EXPECTED": "${{ needs.package.outputs.sha256 }}",
            "VERSION": "${{ needs.package.outputs.version }}"
          },
          "run": "actual=$(sha256sum \"$TARBALL\" | cut -d' ' -f1)\nif [ \"$actual\" != \"$EXPECTED\" ]; then\n  echo \"sha256 mismatch: packed $EXPECTED, downloaded $actual\"\n  exit 1\nfi\n# --ignore-zeros reads past a lone zero block, as npm's own tar reader\n# does, so entries hidden behind one are seen (and refused) here too.\n# The check script then reads the tarball again with the tar library\n# npm itself resolves, which must see exactly the same entries and\n# package.json bytes.\ntar --ignore-zeros -tzf \"$TARBALL\" > \"$RUNNER_TEMP/entries.txt\"\ntar --ignore-zeros -tvzf \"$TARBALL\" | cut -c1 > \"$RUNNER_TEMP/types.txt\"\ncat > \"$RUNNER_TEMP/check.cjs\" <<'CHECK'\n<check.cjs>\nCHECK\nnode \"$RUNNER_TEMP/check.cjs\" \"$RUNNER_TEMP/entries.txt\" \"$RUNNER_TEMP/types.txt\" \"$TARBALL\" \"$(npm root -g)/npm\"\n"
        },
        {
          "name": "Stage on npm",
          "env": {
            "TARBALL": "${{ runner.temp }}/sdk-tarball/${{ needs.package.outputs.tarball }}"
          },
          "run": "npm stage publish --provenance --access public \"$TARBALL\""
        }
      ]
    });
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
    // A folded block parses differently across YAML parsers. The publish
    // job's check step is the last one that starts this way.
    const literal = "        run: |\n          actual=$(sha256sum";
    const at = real.lastIndexOf(literal);
    expect(at).toBeGreaterThan(real.indexOf(`      - name: ${PUBLISH_CHECK_STEP}`));
    const folded = `${real.slice(0, at)}        run: >${real.slice(at + "        run: |".length)}`;
    expect(folded).not.toBe(real);
    expect(() => publishCheckScript(folded)).toThrow("single literal block (run: |)");
    // Chomping and indentation indicators parse to the same script here, so
    // only the header check refuses them.
    for (const header of ["|-", "|+", "|2"]) {
      const variant = `${real.slice(0, at)}        run: ${header}${real.slice(at + "        run: |".length)}`;
      expect(String(Reflect.get(publishJobStep(variant, PUBLISH_CHECK_STEP), "run")).replace(/\n+$/, "")).toBe(
        String(Reflect.get(publishJobStep(real, PUBLISH_CHECK_STEP), "run")).replace(/\n+$/, ""),
      );
      expect(() => publishCheckScript(variant)).toThrow("single literal block (run: |)");
    }
  });

  // The check step's run block, as raw lines, and the text around it.
  function splitCheckStep(text: string): { before: string; header: string; block: string[]; after: string } {
    const header = `      - name: ${PUBLISH_CHECK_STEP}\n`;
    const start = text.indexOf(header);
    const run = text.indexOf("        run: |\n", start) + "        run: |\n".length;
    const next = text.indexOf("\n      - name: ", run);
    return {
      before: text.slice(0, start),
      header: text.slice(start, run),
      block: text.slice(run, next).split("\n"),
      after: text.slice(next),
    };
  }

  test("refuses a workflow that is not printable ASCII with LF line endings", () => {
    const real = workflow("publish-sdk.yml");
    // NEL ends a line for GitHub's YAML parser but not for Bun's or for
    // JavaScript, so this comment would become a heredoc terminator in the job.
    const anchor = '          const fs = require("node:fs");\n';
    for (const character of ["\u0085", "\u2028", "\u2029", "\r", "\t", "\ufeff"]) {
      const injected = real.replace(
        anchor,
        `${anchor}          // a comment${character}          CHECK${character}          cat > /dev/null <<'CHECK'\n`,
      );
      expect(injected).not.toBe(real);
      expect(() => publishCheckScript(injected)).toThrow("printable ASCII");
    }
  });

  test("refuses a run block whose raw text differs from its parsed value", () => {
    // Indented deeper than ten spaces, the block still parses to the same
    // script, but its raw lines do not: only the raw-equals-parsed check
    // refuses it.
    const real = workflow("publish-sdk.yml");
    const step = splitCheckStep(real);
    const deeper = step.block.map((line) => (line === "" ? line : `  ${line}`)).join("\n");
    const indented = `${step.before}${step.header}${deeper}${step.after}`;
    expect(indented).not.toBe(real);
    expect(Reflect.get(publishJobStep(indented, PUBLISH_CHECK_STEP), "run")).toBe(
      Reflect.get(publishJobStep(real, PUBLISH_CHECK_STEP), "run"),
    );
    expect(() => publishCheckScript(indented)).toThrow("parses as written");
  });

  test("reads a blank line inside the check script", () => {
    const real = workflow("publish-sdk.yml");
    const anchor = '          const fs = require("node:fs");\n';
    const spaced = real.replace(anchor, `${anchor}\n`);
    expect(spaced).not.toBe(real);
    expect(publishCheckScript(spaced)).toBe(publishCheckScript(real).replace(
      'const fs = require("node:fs");\n',
      'const fs = require("node:fs");\n\n',
    ));
  });

  test("refuses a check step with two run keys, or a second step of its name", () => {
    const real = workflow("publish-sdk.yml");
    const step = splitCheckStep(real);
    // A repeated key with the same value: Bun keeps the last, GitHub refuses
    // the file. The second copy is double-quoted with its opener escaped, so
    // only the count of run keys can refuse it.
    const run = String(Reflect.get(publishJobStep(real, PUBLISH_CHECK_STEP), "run"));
    const quotedRun = JSON.stringify(run).replaceAll("<<'CHECK'", "\\x3c\\x3c'CHECK'");
    // Directly after the block, and after the comment lines that follow it.
    const afterContent = step.block.length -
      [...step.block].reverse().findIndex((line) => line.startsWith(" ".repeat(10)));
    expect(afterContent).toBeLessThan(step.block.length);
    for (const at of [afterContent, step.block.length]) {
      const lines = [...step.block.slice(0, at), `        run: ${quotedRun}`, ...step.block.slice(at)];
      const twice = `${step.before}${step.header}${lines.join("\n")}${step.after}`;
      expect(Reflect.get(publishJobStep(twice, PUBLISH_CHECK_STEP), "run")).toBe(run);
      expect(() => publishCheckScript(twice)).toThrow("single literal block");
    }
    const repeated = real.replace(
      "\n      - name: Stage on npm\n",
      `\n      - name: ${PUBLISH_CHECK_STEP}\n        run: echo\n      - name: Stage on npm\n`,
    );
    expect(repeated).not.toBe(real);
    expect(() => publishCheckScript(repeated)).toThrow("exactly one");
  });

  test("does not read a step of the same name from another job", () => {
    // The real step is written with a quoted name and a double-quoted run
    // (its opener escaped), and a never-run copy in the verify job carries
    // the plain header and the literal block. The raw text must come from
    // the publish job itself.
    const real = workflow("publish-sdk.yml");
    const step = splitCheckStep(real);
    const run = String(Reflect.get(publishJobStep(real, PUBLISH_CHECK_STEP), "run"));
    const quotedRun = JSON.stringify(run).replaceAll("<<'CHECK'", "\\x3c\\x3c'CHECK'");
    const quotedHeader = step.header
      .replace(`      - name: ${PUBLISH_CHECK_STEP}`, `      - name: "${PUBLISH_CHECK_STEP}"`)
      .replace("        run: |\n", `        run: ${quotedRun}\n`);
    const disguised = `${step.before}${quotedHeader}${step.after.slice(1)}`;
    const decoy = disguised.replace(
      "\n      - name: Smoke-test the exact tarball\n",
      `\n      - name: ${PUBLISH_CHECK_STEP}\n        if: false\n        run: |\n${step.block.join("\n")}\n      - name: Smoke-test the exact tarball\n`,
    );
    expect(decoy).not.toBe(disguised);
    expect(Reflect.get(publishJobStep(decoy, PUBLISH_CHECK_STEP), "run")).toBe(run);
    expect(() => publishCheckScript(decoy)).toThrow("exactly one");
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
      timeout: 60_000,
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
      const entries = spawnSync("tar", ["--ignore-zeros", "-tzf", tarball], { encoding: "utf8", timeout: 60_000 }).stdout;
      const types = spawnSync("tar", ["--ignore-zeros", "-tvzf", tarball], { encoding: "utf8", timeout: 60_000 })
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
          timeout: 60_000,
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
      expect(result.output).toContain("npm's tar library resolves outside npm");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses a tar library in a sibling directory whose name extends npm's", () => {
    // NODE_PATH points at <dir>-x/node_modules, which starts with <dir>.
    const dir = mkdtempSync(join(tmpdir(), "synxed-npm-sibling-"));
    const sibling = `${dir}-x`;
    try {
      mkdirSync(join(dir, "node_modules", "pacote"), { recursive: true });
      mkdirSync(join(sibling, "node_modules", "tar"), { recursive: true });
      writeFileSync(
        join(sibling, "node_modules", "tar", "index.js"),
        `module.exports = require(${JSON.stringify(npmTarLibrary)});\n`,
      );
      const result = runCheck({}, [], dir, [], undefined, { NODE_PATH: join(sibling, "node_modules") });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("npm's tar library resolves outside npm");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  test("refuses a tar library in a directory whose name extends npm's node_modules", () => {
    // NODE_PATH points at <dir>/node_modules-x, which starts with
    // <dir>/node_modules but is outside it: the guard needs the separator.
    const dir = mkdtempSync(join(tmpdir(), "synxed-npm-separator-"));
    try {
      mkdirSync(join(dir, "node_modules", "pacote"), { recursive: true });
      mkdirSync(join(dir, "node_modules-x", "tar"), { recursive: true });
      writeFileSync(
        join(dir, "node_modules-x", "tar", "index.js"),
        `module.exports = require(${JSON.stringify(npmTarLibrary)});\n`,
      );
      const result = runCheck({}, [], dir, [], undefined, { NODE_PATH: join(dir, "node_modules-x") });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("npm's tar library resolves outside npm");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts npm's directory reached through a symbolic link", () => {
    const dir = mkdtempSync(join(tmpdir(), "synxed-npm-link-"));
    try {
      mkdirSync(join(dir, "real", "node_modules", "pacote"), { recursive: true });
      mkdirSync(join(dir, "real", "node_modules", "tar"));
      writeFileSync(
        join(dir, "real", "node_modules", "tar", "index.js"),
        `module.exports = require(${JSON.stringify(npmTarLibrary)});\n`,
      );
      symlinkSync(join(dir, "real"), join(dir, "link"));
      const result = runCheck({}, [], join(dir, "link"));
      expect(result.output).toContain("files checked");
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses pacote linked from outside npm's directory, as pacote would read its own neighbour", () => {
    // pacote really lives in <dir>/outside, next to a tar of its own; npm's
    // directory only links to it. At run time pacote loads the tar beside its
    // real location, which is not npm's.
    const dir = mkdtempSync(join(tmpdir(), "synxed-npm-pacote-link-"));
    try {
      mkdirSync(join(dir, "outside", "node_modules", "pacote"), { recursive: true });
      mkdirSync(join(dir, "outside", "node_modules", "tar"));
      writeFileSync(
        join(dir, "outside", "node_modules", "tar", "index.js"),
        `module.exports = require(${JSON.stringify(npmTarLibrary)});\n`,
      );
      mkdirSync(join(dir, "npm", "node_modules", "tar"), { recursive: true });
      writeFileSync(
        join(dir, "npm", "node_modules", "tar", "index.js"),
        `module.exports = require(${JSON.stringify(npmTarLibrary)});\n`,
      );
      symlinkSync(join(dir, "outside", "node_modules", "pacote"), join(dir, "npm", "node_modules", "pacote"));
      const result = runCheck({}, [], join(dir, "npm"));
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("npm's tar library resolves outside npm");
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
          { encoding: "utf8", timeout: 60_000 },
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
