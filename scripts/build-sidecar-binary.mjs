#!/usr/bin/env node
/**
 * Sidecar como binário único: o app distribuído deixa de exigir Node instalado.
 *
 * 1. esbuild junta `packages/agent-runtime/src/main.ts` e as dependências num CommonJS só
 *    (o SEA do Node exige CommonJS sem `await` no topo).
 * 2. Node SEA: `node --experimental-sea-config` gera o blob, e o `postject` o injeta numa cópia
 *    de um Node autossuficiente. O Node do Homebrew NÃO serve: ele liga com libuv, OpenSSL, ICU etc.
 *    de /opt/homebrew, que não existem em outra máquina (e o hardened runtime recusa carregar).
 *    Use o binário oficial de nodejs.org (estático): `OCTOPUS_SEA_NODE=/caminho/node-v24…/bin/node`.
 *    O script confere com `otool -L` e para se o Node depender de algo fora de /usr/lib e /System.
 *    No macOS a assinatura é removida antes e refeita ad-hoc depois (o Tauri assina de novo).
 * 3. O Claude Code nativo que o SDK executa (`@anthropic-ai/claude-agent-sdk-<plataforma>/claude`)
 *    vai junto. O sidecar o encontra ao lado de si (`paths.ts`).
 *
 * Saída em `apps/desktop/src-tauri/binaries/` com o sufixo de target que o `externalBin` do Tauri
 * espera: `agent-runtime-<triple>` e `claude-<triple>` (no .app viram `Contents/MacOS/agent-runtime`
 * e `Contents/MacOS/claude`).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = join(root, "packages/agent-runtime");
const outDir = join(root, "apps/desktop/src-tauri/binaries");
const workDir = join(root, "apps/desktop/src-tauri/target/sidecar-sea");
const require = createRequire(join(runtimeDir, "package.json"));

const triples = { "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin", "linux-x64": "x86_64-unknown-linux-gnu", "linux-arm64": "aarch64-unknown-linux-gnu" };
const platform = `${process.platform}-${process.arch}`;
const triple = triples[platform];
if (!triple) {
  console.error(`[sidecar-binary] plataforma sem suporte: ${platform}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) {
    console.error(`[sidecar-binary] falhou: ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

function pkgVersion(name) {
  let dir = dirname(require.resolve(name));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, "utf8"));
      if (pkg.name === name) return pkg.version;
    }
    dir = dirname(dir);
  }
  return "desconhecida";
}

/** Node que vai dentro do binário: `OCTOPUS_SEA_NODE` ou o que roda este script. */
const seaNode = process.env.OCTOPUS_SEA_NODE ?? process.execPath;
if (process.platform === "darwin") {
  const libs = spawnSync("otool", ["-L", seaNode], { encoding: "utf8" }).stdout.split("\n").slice(1).map((l) => l.trim().split(" ")[0]).filter(Boolean);
  const foreign = libs.filter((l) => !l.startsWith("/usr/lib/") && !l.startsWith("/System/"));
  if (foreign.length) {
    console.error(`[sidecar-binary] ${seaNode} depende de bibliotecas fora do sistema e não roda em outra máquina:\n  ${foreign.join("\n  ")}\nBaixe o Node oficial (https://nodejs.org/dist/) e aponte OCTOPUS_SEA_NODE para o bin/node dele.`);
    process.exit(1);
  }
}
const seaNodeVersion = spawnSync(seaNode, ["--version"], { encoding: "utf8" }).stdout.trim();
console.log(`[sidecar-binary] Node embutido: ${seaNode} (${seaNodeVersion})`);

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

// 1. Bundle CommonJS.
const { build } = await import("esbuild");
const bundle = join(workDir, "main.cjs");
await build({
  entryPoints: [join(runtimeDir, "src/main.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  logLevel: "warning",
  // No SEA `require` só carrega módulos nativos do Node; `import.meta.url` vira o caminho do executável.
  banner: { js: 'const __octopus_import_meta_url = require("node:url").pathToFileURL(__filename).href;' },
  define: {
    "import.meta.url": "__octopus_import_meta_url",
    __OCTOPUS_RUNTIME_VERSION__: JSON.stringify(JSON.parse(readFileSync(join(runtimeDir, "package.json"), "utf8")).version),
    __OCTOPUS_SDK_VERSION__: JSON.stringify(pkgVersion("@anthropic-ai/claude-agent-sdk")),
  },
});

// 2. Blob SEA injetado numa cópia do node.
const blob = join(workDir, "sea-prep.blob");
const seaConfig = join(workDir, "sea-config.json");
writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false }));
// O blob precisa ser gerado pela mesma versão do Node que vai recebê-lo.
run(seaNode, ["--experimental-sea-config", seaConfig]);

const binary = join(outDir, `agent-runtime-${triple}`);
rmSync(binary, { force: true });
copyFileSync(seaNode, binary);
chmodSync(binary, 0o755);
const isMac = process.platform === "darwin";
if (isMac) run("codesign", ["--remove-signature", binary]);
const postject = join(root, "node_modules/.bin/postject");
run(postject, [binary, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2", ...(isMac ? ["--macho-segment-name", "NODE_SEA"] : [])]);
if (isMac) run("codesign", ["--sign", "-", "--force", binary]);

// 3. Claude Code nativo da plataforma.
const claudePkg = `@anthropic-ai/claude-agent-sdk-${platform}`;
let claudeSrc;
try {
  claudeSrc = join(dirname(createRequire(require.resolve("@anthropic-ai/claude-agent-sdk")).resolve(`${claudePkg}/package.json`)), "claude");
} catch {
  console.error(`[sidecar-binary] ${claudePkg} não está instalado (npm install sem --omit=optional)`);
  process.exit(1);
}
const claude = join(outDir, `claude-${triple}`);
rmSync(claude, { force: true });
copyFileSync(claudeSrc, claude);
chmodSync(claude, 0o755);

// Fumaça: o binário responde ao handshake sem Node no PATH.
const hello = spawnSync(binary, [], {
  input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "runtime.hello", params: { protocolVersion: 1 } }) + "\n",
  env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "" },
  encoding: "utf8",
  timeout: 20_000,
});
const reply = (hello.stdout ?? "").split("\n").find((l) => l.includes('"id":1'));
if (!reply || !reply.includes('"protocolVersion":1')) {
  console.error("[sidecar-binary] o binário não respondeu ao runtime.hello:\n", hello.stdout, hello.stderr);
  process.exit(1);
}
const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(0);
console.log(`[sidecar-binary] ${binary} (${mb(binary)} MB) e ${claude} (${mb(claude)} MB)`);
console.log(`[sidecar-binary] handshake ok: ${reply.trim()}`);
