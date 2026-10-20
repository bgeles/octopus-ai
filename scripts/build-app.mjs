#!/usr/bin/env node
/**
 * Build de distribuição do Octopus (Fase 7).
 *
 * - Assina os artefatos do updater com a chave privada em ~/.tauri/octopus-updater.key (fora do
 *   repositório). Sem a chave, gera o .app/.dmg sem artefatos de update.
 * - Assinatura de código: ad-hoc ("-") por padrão. Para distribuir, defina APPLE_SIGNING_IDENTITY
 *   ("Developer ID Application: …") e, para notarizar, APPLE_ID, APPLE_PASSWORD (senha de app) e
 *   APPLE_TEAM_ID; o Tauri usa essas variáveis direto.
 * - Gera release/latest.json (manifesto do updater) com a URL base em OCTOPUS_RELEASE_BASE_URL.
 * - Sidecar: binário único (Node SEA) + Claude Code nativo em Contents/MacOS, via `externalBin`
 *   (scripts/build-sidecar-binary.mjs); a máquina não precisa de Node. `OCTOPUS_SIDECAR=node`
 *   volta ao modo antigo (scripts/bundle-sidecar.mjs nos resources, rodando com o node da máquina).
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(root, "apps/desktop");
const conf = JSON.parse(readFileSync(join(app, "src-tauri/tauri.conf.json"), "utf8"));
const keyPath = process.env.OCTOPUS_UPDATER_KEY ?? join(homedir(), ".tauri/octopus-updater.key");
const env = { ...process.env };
const args = ["tauri", "build"];
/** Sobrescritas do tauri.conf.json, mescladas num único `--config`. */
const overrides = {};
if (env.OCTOPUS_SIDECAR !== "node") {
  for (const step of [
    ["npm", ["run", "build", "-w", "@octopus/protocol"]],
    ["node", [join(root, "scripts/build-sidecar-binary.mjs")]],
  ]) {
    const s = spawnSync(step[0], step[1], { cwd: root, env, stdio: "inherit" });
    if (s.status !== 0) process.exit(s.status ?? 1);
  }
  overrides.bundle = { externalBin: ["binaries/agent-runtime", "binaries/claude"], macOS: { entitlements: "Entitlements.plist" } };
  console.log("[build-app] sidecar como binário único (sem Node na máquina)");
} else {
  overrides.build = { beforeBuildCommand: "npm run sidecar:build && npm run build && node ../../scripts/bundle-sidecar.mjs" };
  overrides.bundle = { resources: { "sidecar-bundle/": "sidecar/" } };
  console.log("[build-app] sidecar no modo node (resources + node da máquina)");
}
if (existsSync(keyPath)) {
  env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyPath, "utf8");
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "";
  console.log(`[build-app] artefatos do updater assinados com ${keyPath}`);
} else {
  console.log("[build-app] sem chave do updater: gerando só .app/.dmg (crie com `npx tauri signer generate -w ~/.tauri/octopus-updater.key`)");
  overrides.bundle = { ...(overrides.bundle ?? {}), createUpdaterArtifacts: false };
}
if (Object.keys(overrides).length) args.push("--config", JSON.stringify(overrides));
if (env.APPLE_SIGNING_IDENTITY) console.log(`[build-app] assinatura de código: ${env.APPLE_SIGNING_IDENTITY}`);
else console.log("[build-app] assinatura de código ad-hoc (uso local; para distribuir defina APPLE_SIGNING_IDENTITY)");

const r = spawnSync("npx", args, { cwd: app, env, stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);

const bundleDir = join(app, "src-tauri/target/release/bundle");
const macos = join(bundleDir, "macos");
const tarball = existsSync(macos) ? readdirSync(macos).find((f) => f.endsWith(".app.tar.gz")) : undefined;
if (!tarball) {
  console.log("[build-app] pronto (sem latest.json: build sem artefatos de update)");
  process.exit(0);
}
const sig = readFileSync(join(macos, `${tarball}.sig`), "utf8").trim();
const out = join(root, "release");
mkdirSync(out, { recursive: true });
const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
const base = (process.env.OCTOPUS_RELEASE_BASE_URL ?? `https://releases.example.com/octopus/${conf.version}`).replace(/\/$/, "");
const assetName = tarball.replace(/ /g, "_");
copyFileSync(join(macos, tarball), join(out, assetName));
const dmgDir = join(bundleDir, "dmg");
for (const f of existsSync(dmgDir) ? readdirSync(dmgDir).filter((f) => f.endsWith(".dmg")) : []) copyFileSync(join(dmgDir, f), join(out, f.replace(/ /g, "_")));
const manifest = {
  version: conf.version,
  notes: process.env.OCTOPUS_RELEASE_NOTES ?? `Octopus AI ${conf.version}`,
  pub_date: new Date().toISOString(),
  platforms: { [`darwin-${arch}`]: { signature: sig, url: `${base}/${assetName}` } },
};
writeFileSync(join(out, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`[build-app] release/ pronto: ${assetName}, latest.json (url base ${base})`);
