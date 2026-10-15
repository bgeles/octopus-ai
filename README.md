# Octopus AI

Orquestrador de projetos com agentes de IA para macOS. App Tauri 2 (React + Rust) com um sidecar Node que hospeda o Claude Agent SDK.

Estado atual: **Fase 0** (fundação). Um projeto aponta para uma pasta, você manda um prompt e acompanha o agente ao vivo: streaming de texto, chamadas de ferramenta, pedidos de permissão, uso de contexto e custo. Tudo persistido em SQLite.

O plano completo (arquitetura, modelo de dados, fases 1 a 7) está em `docs/plano.md`. A proposta visual aprovada está no Claude Design.

## Arquitetura em uma frase

UI React (WebView) ⇄ core Rust (SQLite, supervisor, comandos Tauri) ⇄ sidecar Node (`@octopus/agent-runtime`, JSON-RPC em NDJSON por stdio) ⇄ Claude Agent SDK.

```
apps/desktop/            app Tauri: src/ (React) e src-tauri/ (Rust)
packages/protocol/       contrato Rust <-> sidecar <-> UI (schemas Zod + fixtures compartilhadas)
packages/agent-runtime/  sidecar Node com o Claude Agent SDK
docs/                    plano e documentação do protocolo
```

## Pré-requisitos

- macOS em Apple Silicon, Xcode ou Command Line Tools
- Node 22.14+ ou 24 LTS (Node 23 funciona, mas exige `jsdom` 26 nos testes)
- npm 12 (`npm install -g npm@12`): o npm 11 tem um bug no resolvedor de workspaces
- Rust estável via rustup (`brew install rustup && rustup toolchain install stable`)
- Claude Code autenticado nesta máquina (modo assinatura) ou uma `ANTHROPIC_API_KEY`

## Rodando

```bash
npm install
npm run dev
```

`npm run dev` compila o protocolo e o sidecar, sobe o Vite e abre o app pelo Tauri. Sem Tauri (só o navegador), `npx vite` em `apps/desktop` usa um transporte de mock que reproduz as fixtures do protocolo.

## Testes

```bash
npm test                 # vitest: protocolo, sidecar e UI
npm run test:rust        # cargo test: store, protocolo, supervisor (com sidecar falso em Node)
npm run test:e2e -w @octopus/desktop   # Playwright contra a UI com mock
```

O CI (`.github/workflows/ci.yml`) roda tudo isso em macOS, mais `cargo fmt --check` e `cargo clippy -D warnings`.

## Fluxo de branches

O desenvolvimento segue as fases do `docs/plano.md`, uma branch por fase e uma por iteração dentro da fase.

| Branch | Papel |
|---|---|
| `main` | Estável. Só recebe merge de uma fase concluída e verificada. Cada fase fechada ganha a tag `fase-N`. |
| `fase-N/<slug>` | Branch de integração da fase (ex.: `fase-1/sessoes-aprovacoes`), criada a partir de `main`. |
| `fase-N/iter-K-<slug>` | Iteração dentro da fase (ex.: `fase-1/iter-01-tema-grafite`), criada a partir da branch da fase, com PR de volta para ela. |

Regras: PRs de iteração entram na branch da fase com a suíte de testes verde no CI; a branch da fase só vai para `main` quando os critérios de "pronto quando" da fase no plano forem cumpridos.

## Onde ficam os dados

`~/Library/Application Support/ai.octopus.desktop/octopus.db` (SQLite). As sessões do Claude continuam em `~/.claude/projects/`.

## Variáveis úteis

| Variável | Efeito |
|---|---|
| `OCTOPUS_SIDECAR_PROGRAM` / `OCTOPUS_SIDECAR_ARGS` | Força o comando do sidecar (ex.: `node` + caminho do `main.js`). |
| `RUST_LOG` | Filtro de logs do core (padrão `info,octopus_desktop_lib=debug`). |
| `ANTHROPIC_API_KEY` | Usada pelo sidecar quando o projeto estiver em modo `api_key`. |

## Aviso de licença

O login do claude.ai (assinatura) só pode ser usado para uso próprio. Para distribuir o app a terceiros, use API key.
