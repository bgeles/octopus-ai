#!/usr/bin/env node
/**
 * Monta `apps/desktop/src-tauri/sidecar-bundle/` com o sidecar compilado e só as dependências
 * de runtime de que ele precisa, para o Tauri empacotar como resource (`sidecar/` dentro do .app).
 *
 * Em release o app roda `node <Resources>/sidecar/agent-runtime/dist/main.js`. O Node continua
 * sendo um pré-requisito da máquina (como o login do Claude Code); o binário único fica para a Fase 7.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "apps/desktop/src-tauri/sidecar-bundle");
const runtimeDir = resolve(root, "packages/agent-runtime");

if (!existsSync(join(runtimeDir, "dist/main.js"))) {
  console.error("sidecar não compilado: rode `npm run build -w @octopus/protocol -w @octopus/agent-runtime` antes.");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "agent-runtime"), { recursive: true });
cpSync(join(runtimeDir, "dist"), join(out, "agent-runtime/dist"), { recursive: true, dereference: true });
cpSync(join(runtimeDir, "package.json"), join(out, "agent-runtime/package.json"));

/** Resolve o diretório real de um pacote a partir de quem o importa (node_modules hoisted ou aninhado). */
function locate(name, from) {
  let dir = from;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const copied = new Map(); // nome -> caminho real copiado
const missing = [];
function collect(pkgDir, name) {
  if (name && copied.has(name)) return;
  if (name) copied.set(name, pkgDir);
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const wanted = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ];
  for (const dep of wanted) {
    const dir = locate(dep, pkgDir);
    if (!dir) {
      // Opcionais de outras plataformas não existem localmente: normal.
      if (!(pkg.optionalDependencies && dep in pkg.optionalDependencies) && !(pkg.peerDependenciesMeta?.[dep]?.optional)) missing.push(`${dep} (de ${name ?? "agent-runtime"})`);
      continue;
    }
    collect(dir, dep);
  }
}
collect(runtimeDir, null);

const modulesOut = join(out, "agent-runtime/node_modules");
let bytes = 0;
for (const [name, dir] of copied) {
  const dest = join(modulesOut, name);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(dir, dest, {
    recursive: true,
    dereference: true,
    filter: (src) => !/\/(\.bin|node_modules\/\.cache|test|tests|__tests__|docs?)(\/|$)/.test(src) && !/\.(md|map|d\.ts|d\.mts|d\.cts)$/.test(src),
  });
  bytes += sizeOf(dest);
}

function sizeOf(path) {
  const st = statSync(path);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const entry of readdirSync(path)) total += sizeOf(join(path, entry));
  return total;
}

writeFileSync(
  join(out, "MANIFEST.json"),
  JSON.stringify({ builtAt: new Date().toISOString(), node: process.version, packages: Object.fromEntries([...copied].map(([n, d]) => [n, JSON.parse(readFileSync(join(d, "package.json"), "utf8")).version])) }, null, 2),
);

console.log(`sidecar-bundle: ${copied.size} pacotes, ${(bytes / 1024 / 1024).toFixed(1)} MB em ${out}`);
for (const name of [...copied.keys()].sort()) console.log(`  - ${name}`);
if (missing.length) {
  console.error("dependências não encontradas:", missing.join(", "));
  process.exit(1);
}
