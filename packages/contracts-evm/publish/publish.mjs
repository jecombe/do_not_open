#!/usr/bin/env node
/**
 * Publishes the game's and the vault's contracts to their own GitLab repositories.
 *
 * Each repository is rebuilt from scratch from the committed tree (HEAD, never the working tree):
 * the files its manifest (`<name>.json`) lists and nothing else, the templates next to this script,
 * the deployed addresses (no bytecode, no compiler input), and for the game the spec and the
 * generator its tests need. Then it is checked: no secret, nothing of the rest of the monorepo, and
 * it installs, compiles and passes its tests alone. Only then is it committed, as one commit with
 * the subject of the last commit that touched what it publishes, and pushed. Nothing changed:
 * nothing is pushed.
 *
 *   node publish.mjs --dry-run            builds both into a folder and stops there
 *   node publish.mjs --only vault         one repository
 *   node publish.mjs --skip-tests         compiles, skips the tests (local tries only)
 *
 * The deploy key of each repository comes from its `keyEnv` variable (the key itself, as in CI),
 * or `<keyEnv>_FILE` (a path, for a local run).
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = dirname(HERE);
const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: HERE, encoding: "utf8" }).trim();
const SOURCES = ["packages/contracts-evm", "packages/game-spec", "packages/generator"];
/** GitLab's published host key: a push never goes to a server that only claims to be gitlab.com. */
const GITLAB_HOST_KEY = "gitlab.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf";
const AUTHOR = { name: "DO NOT OPEN", email: "contracts@do-not-open.app" };
const EXPLORER = "https://sepolia.etherscan.io/address/";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const skipTests = args.includes("--skip-tests");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

const work = mkdtempSync(join(tmpdir(), "dno-publish-"));
const run = (cmd, argv, cwd, env = {}) => execFileSync(cmd, argv, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
const read = (cmd, argv, cwd, env = {}) => execFileSync(cmd, argv, { cwd, encoding: "utf8", env: { ...process.env, ...env } }).trim();

/** Every file under `dir`, as paths relative to it with forward slashes. */
function walk(dir, base = dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === ".git" || name === "node_modules") return [];
    return statSync(full).isDirectory() ? walk(full, base) : [relative(base, full).split(sep).join("/")];
  });
}

/** `*` within a folder, `**` across folders. */
const globRegex = (glob) =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`);

/** The files a list of globs keeps, in order: `!glob` takes back what an earlier one matched. */
function select(files, globs) {
  const kept = new Set();
  for (const glob of globs) {
    const negate = glob.startsWith("!");
    const re = globRegex(negate ? glob.slice(1) : glob);
    const hits = files.filter((f) => re.test(f));
    if (!negate && hits.length === 0) console.warn(`  (nothing matches ${glob})`);
    for (const f of hits) negate ? kept.delete(f) : kept.add(f);
  }
  return [...kept].sort();
}

function copy(from, to, files) {
  for (const f of files) {
    mkdirSync(dirname(join(to, f)), { recursive: true });
    cpSync(join(from, f), join(to, f));
  }
}

/** The exact versions the monorepo resolves, so the published repository compiles the same code. */
function versions(names) {
  const versionOf = (name) => {
    for (let dir = PACKAGE; dir !== dirname(dir); dir = dirname(dir)) {
      const file = join(dir, "node_modules", name, "package.json");
      if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).version;
    }
    throw new Error(`${name} is not installed: run pnpm install first.`);
  };
  return Object.fromEntries(names.map((n) => [n, versionOf(n)]));
}

/** The deployed addresses, without bytecode, metadata or compiler input (those hold other contracts' sources). */
function deployments(src, names) {
  const dir = join(src, "packages/contracts-evm/deployments/sepolia");
  const out = {};
  for (const name of names) {
    const file = join(dir, `${name}.json`);
    if (!existsSync(file)) continue;
    const d = JSON.parse(readFileSync(file, "utf8"));
    out[name] = { address: d.address, transactionHash: d.transactionHash, blockNumber: d.receipt?.blockNumber ?? null, args: d.args ?? [], abi: d.abi };
  }
  return out;
}

function deploymentsMarkdown(deployed) {
  const rows = Object.entries(deployed).map(
    ([name, d]) => `| \`${name}\` | [\`${d.address}\`](${EXPLORER}${d.address}) | ${d.blockNumber ?? "—"} |`,
  );
  return `# Deployments

Ethereum Sepolia (chain id 11155111). The ABIs and the constructor arguments are in
\`addresses/sepolia.json\`.

| Contract | Address | Block |
| --- | --- | --- |
${rows.join("\n")}
`;
}

/** Fails on anything that should never leave the monorepo. */
function guard(dir) {
  const problems = [];
  const banned = [/(^|\/)\.env$/, /\.pem$/, /(^|\/)id_[a-z0-9]+$/, /\.test-wallets\.json$/, /(^|\/)solcInputs\//];
  const leaks = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
    [/(PRIVATE_KEY|_SECRET|_TOKEN|API_KEY)\s*=\s*["']?[A-Za-z0-9_\-]{16,}/, "a secret value"],
    [/\bMNEMONIC\s*=\s*["']?[a-z]+( [a-z]+){11}/, "a mnemonic"],
    [/@dno\/(chain-adapter|scene|web|api|admin)\b|\bapps\/(web|api|admin)\b|chain-adapter\/|\/opt\/dno/, "a reference to the rest of the monorepo"],
    [/jeremcombe|herald_dno/i, "a personal identifier"],
  ];
  for (const f of walk(dir)) {
    if (banned.some((re) => re.test(f))) problems.push(`${f}: file not allowed`);
    if (/\.(png|jpe?g|gif|webp|ico)$/i.test(f)) continue;
    const text = readFileSync(join(dir, f), "utf8");
    for (const [re, what] of leaks) if (re.test(text)) problems.push(`${f}: ${what}`);
  }
  if (problems.length) throw new Error(`Refusing to publish:\n  ${problems.join("\n  ")}`);
}

function build(manifest, src, dest) {
  const contracts = join(src, "packages/contracts-evm");
  copy(contracts, dest, select(walk(contracts), manifest.files));
  for (const dir of ["common", manifest.name]) cpSync(join(HERE, "templates", dir), dest, { recursive: true });

  for (const [pkg, globs] of Object.entries(manifest.vendor ?? {})) {
    const from = join(src, "packages", pkg);
    copy(from, join(dest, "vendor", pkg), select(walk(from), globs));
  }
  if (manifest.vendor?.generator) {
    // The generator resolves the spec from the repository's own node_modules.
    writeFileSync(
      join(dest, "vendor/generator/package.json"),
      JSON.stringify({ name: "@dno/generator", version: "0.1.0", private: true, main: "src/index.ts", types: "src/index.ts" }, null, 2) + "\n",
    );
  }

  const config = join(dest, "hardhat.config.ts");
  writeFileSync(config, readFileSync(config, "utf8").replace("      /* overrides */\n", manifest.solidityOverrides ? `      ${manifest.solidityOverrides}\n` : ""));

  const vendored = Object.keys(manifest.vendor ?? {}).map((p) => [`@dno/${p}`, `file:vendor/${p}`]);
  const pkg = {
    name: `do-not-open-${manifest.name}`,
    version: "1.0.0",
    private: true,
    license: "MIT",
    scripts: {
      compile: "cross-env TS_NODE_TRANSPILE_ONLY=true hardhat compile",
      test: "cross-env TS_NODE_TRANSPILE_ONLY=true hardhat test",
      "deploy:sepolia": `hardhat deploy --network sepolia${manifest.deployTags ? ` --tags ${manifest.deployTags}` : ""}`,
      "verify:sepolia": "hardhat etherscan-verify --network sepolia",
    },
    dependencies: versions(manifest.dependencies),
    devDependencies: { ...Object.fromEntries(vendored), ...versions(manifest.devDependencies) },
  };
  writeFileSync(join(dest, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

  const deployed = deployments(src, manifest.deployments);
  mkdirSync(join(dest, "addresses"), { recursive: true });
  writeFileSync(join(dest, "addresses/sepolia.json"), JSON.stringify({ chainId: 11155111, contracts: deployed }, null, 2) + "\n");
  writeFileSync(join(dest, "DEPLOYMENTS.md"), deploymentsMarkdown(deployed));
}

/** Installs, compiles and tests the repository on its own, in a copy so its node_modules never reach git. */
function check(dest, name) {
  const trial = join(work, `${name}-check`);
  cpSync(dest, trial, { recursive: true, filter: (p) => !p.split(sep).includes(".git") });
  run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], trial);
  run("npm", ["run", "compile"], trial);
  if (!skipTests) run("npm", ["test"], trial);
}

function sshCommand(manifest) {
  let keyFile = process.env[`${manifest.keyEnv}_FILE`];
  if (!keyFile) {
    const key = process.env[manifest.keyEnv];
    if (!key) throw new Error(`No deploy key: set ${manifest.keyEnv} or ${manifest.keyEnv}_FILE.`);
    keyFile = join(work, `${manifest.name}.key`);
    writeFileSync(keyFile, key.endsWith("\n") ? key : `${key}\n`, { mode: 0o600 });
  }
  const knownHosts = join(work, "known_hosts");
  writeFileSync(knownHosts, `${GITLAB_HOST_KEY}\n`);
  return `ssh -i ${keyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${knownHosts}`;
}

function publish(manifest, src) {
  console.log(`\n== ${manifest.name} ==`);
  const dest = join(work, manifest.name);
  const env = dryRun ? {} : { GIT_SSH_COMMAND: sshCommand(manifest) };
  if (dryRun) {
    mkdirSync(dest);
  } else {
    run("git", ["clone", "--quiet", manifest.remote, dest], work, env);
    for (const entry of readdirSync(dest)) if (entry !== ".git") rmSync(join(dest, entry), { recursive: true, force: true });
  }

  build(manifest, src, dest);
  guard(dest);
  console.log(`  ${walk(dest).length} files`);
  check(dest, manifest.name);

  if (dryRun) {
    console.log(`  built in ${dest}`);
    return;
  }
  const git = (argv) => read("git", argv, dest, env);
  git(["add", "-A"]);
  if (!git(["status", "--porcelain"])) {
    console.log("  nothing changed");
    return;
  }
  const first = !git(["ls-remote", "--heads", "origin"]);
  const subject = first
    ? `Publish the contracts of ${manifest.title}`
    : read("git", ["log", "-1", "--format=%s", "HEAD", "--", ...SOURCES], ROOT);
  run("git", ["-c", `user.name=${AUTHOR.name}`, "-c", `user.email=${AUTHOR.email}`, "commit", "--quiet", "-m", subject], dest, env);
  run("git", ["push", "--quiet", "origin", "HEAD:main"], dest, env);
  console.log(`  pushed: ${subject}`);
}

try {
  // The committed tree only: nothing uncommitted or ignored can be published.
  const src = join(work, "src");
  mkdirSync(src);
  const archive = join(work, "src.tar");
  run("git", ["archive", "--format=tar", "-o", archive, "HEAD", ...SOURCES], ROOT);
  run("tar", ["-xf", archive, "-C", src], ROOT);

  const names = only ? [only] : ["vault", "game"];
  for (const name of names) publish(JSON.parse(readFileSync(join(HERE, `${name}.json`), "utf8")), src);
} finally {
  // The keys written for this run go with it; a dry run keeps what it built to look at.
  for (const f of existsSync(work) ? readdirSync(work) : []) if (f.endsWith(".key")) rmSync(join(work, f));
  if (!dryRun) rmSync(work, { recursive: true, force: true });
}
