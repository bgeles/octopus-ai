# Octopus AI

Orquestrador de projetos com agentes de IA para macOS. App Tauri 2 (React + Rust) com um sidecar Node que hospeda o Claude Agent SDK.

Estado atual: `main` tem as Fases 0 a 5, 7 e 8 (tags `fase-0` a `fase-5`, `fase-7` e `fase-8`) e as lacunas (orçamento no meio do run, esforço por run e hooks livres); a Fase 9 (tela Início, feed de atividade, estados e controles por membro, relatório final do workflow, linha do tempo da task, missão e objetivos, versão na tela) está na branch `fase-9/inicio-e-resultados`. A Fase 6 (isolamento forte em container) ficou opcional para depois. Um projeto aponta para uma pasta; você monta um **time** de agentes com cargos, especialidades e responsabilidades (organograma com delegação), define um **workflow** com estágios e gate humano, e o **scheduler** executa as tasks do board como o membro responsável, respeitando dependências e paralelismo. Cada run mostra streaming, chamadas de ferramenta, subagentes, pedidos de permissão com diff e custo. Onboarding na primeira abertura e backup local das configurações. Segurança em camadas: sandbox por projeto, motor de política `PreToolUse` em Rust, orçamentos mensais, auditoria com cadeia de hashes e API key no Keychain. Memória própria do projeto: observações capturadas por hooks (sanitizadas), wiki em markdown com FTS5, brief injetado em cada run, handoffs entre runs, consolidação opcional com Haiku, pins e medidor de contexto. Tudo persistido em SQLite (segredos só no Keychain; a wiki são arquivos `.md` na pasta de dados).

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
# Com o Claude de verdade (custa centavos; precisa de `claude auth status` com loggedIn: true):
# cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib real_ -- --ignored --nocapture --test-threads=1
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

## O que dá para fazer hoje

| Tela | O que faz |
|---|---|
| Início | Tela inicial (⌘1): cards *Membros em run*, *Aguardando você*, *Gasto do mês* e *Entregas no mês*; painel **Time agora** com o estado de cada membro (em run, aguardando você, pausado, último run falhou, ocioso), o que faz agora e os controles **Pausar/Retomar**, **Rodar agora**, **Dar uma tarefa** e **Ficha**; **Atividade recente** (quem fez o quê, ao vivo: tasks, runs avulsos, aprovações, orçamento, pausas); **Missão e objetivos** com progresso; **Resultado final** (relatório de cada workflow) e **Entregas recentes**. Atualiza sozinha com os eventos dos runs. |
| Run ao vivo | Prompt, streaming, árvore de ferramentas e subagentes, aprovações inline com diff (Edit/Write), custo do run e do projeto. "Executar como" um membro do time. Sidebar com medidor de contexto (alertas em 70% e 90%, "Compactar agora"), brief de memória injetado, compactações e instruções carregadas. |
| Sessões | Listar, retomar, bifurcar, renomear e taguear sessões do Claude na pasta do projeto. |
| Aprovações | Pendentes (decidíveis fora do transcript) e decididas com motivo. |
| Time | Cargos (catálogo com 8 seeds + cargos do projeto), membros com organograma (quem reporta a quem vira subagente), ficha com responsabilidades, "como trabalha" e runs. **Confiança** por membro (herda do cargo): autonomia supervisionado / gerenciado / autônomo, "pode criar e atribuir tasks" e "aprova quem reporta a ele"; cargo seed *Gestor de produto* já vem autônomo, delegando e aprovando. Quem delega ganha as tools `team_list`, `task_list`, `task_create` e `task_assign` (só para quem reporta a ele). Badges de confiança, carga e "criou N" no card e na ficha. |
| Board | Workflows por modelo ("Planejar → Implementar → Revisar → Aprovar", "Pesquisa paralela → Síntese"), tasks com dependências e critérios de aceite, Kanban por estágio, gates humanos, histórico. O scheduler roda a cada 4 s (ou em "Rodar agora"); o agente move a própria task pela tool MCP `task_update`. Worktree git por task opcional. Gate com `gate: você` ou `gate: por política` (a confiança do responsável decide: você, o gestor dele, ou auto-aprovado); status *em revisão por X* com runs de revisão do gestor (sem editar, com limite de devoluções antes de subir para você) e "Aprovar mesmo assim". **Entregas**: resultado em markdown deixado pelo agente, arquivos alterados e diff contra o commit base na própria task, aba Entregas e card Resultado no fim do transcript. Tasks criadas por um membro trazem "criada por <nome>". **Relatório final do workflow**: gerado quando a última task conclui (ou sob demanda), com período, custo, membros, as entregas e os pendentes; resumo executivo opcional com Haiku; Copiar e Exportar `.md`. **Linha do tempo da task**: eventos, runs como cards recolhíveis e seus comentários, que entram no prompt do próximo run. **Missão e objetivos**: missão do projeto e vista *Objetivos* com progresso (tasks concluídas), objetivo por workflow e por task; o porquê entra no prompt de todo run e o time o vê ao delegar. |
| Memória | **Páginas**: wiki do projeto (decisões, arquitetura, armadilhas, log de tarefas) com busca FTS5, versões, arquivar e reindexar a partir dos `.md`; o log de tarefas do mês nasce sozinho ao fim de cada run. **Observações**: o que os hooks capturaram (PostToolUse, Stop, SubagentStop, SessionEnd), com segredos redigidos. **Handoffs**: "onde parei / o que falhou / o que falta" deixados pelo agente ou gerados quando um run de task não termina; o próximo run da task recebe. **Contexto**: pins (arquivo, página, texto) sempre injetados, fontes de instruções (CLAUDE.md) por projeto, o que entrou no último run. Consolidação "Bruta" ou "Com Haiku" (run barato só com `memory_write`). O agente tem as tools MCP `memory_search`, `memory_write` e `memory_handoff`. |
| Harness | **MCPs**: MCP servers externos (stdio, SSE, HTTP) globais ou do projeto, com teste de conexão pelo cliente MCP oficial (handshake + lista de tools) e saúde guardada; entram em `options.mcpServers` junto com o `octopus` embutido. **Skills**: pastas com `SKILL.md` do projeto e do usuário, interruptores, editor e criação; as ativas que o Claude Code não carrega sozinho viram um plugin local montado pelo Octopus (`options.plugins`). **Hooks**: hooks livres (comandos de shell em eventos do agente, globais ou do projeto) com teste por exemplo; só negam ou pedem aprovação, nunca liberam. **Perfil de execução**: defaults do projeto (modelo, turnos, esforço), preview do `options` final com a origem de cada campo (cargo, membro, projeto, segurança, orçamento, memória, harness, contexto, autenticação) e os hooks declarativos ativos. A ficha do membro escolhe MCP servers e skills. |
| Segurança | **Política**: perfil de sandbox do projeto (Estrito, Dev padrão, Somente leitura → `options.sandbox` do SDK), autenticação do projeto (login do Claude Code ou API key guardada no Keychain), regras `PreToolUse` globais e do projeto (deny/ask; as do projeto só apertam) com simulador. **Orçamentos**: aviso e limite mensais por projeto e por membro, turnos por run; o gasto soma o custo estimado dos runs em andamento, e estourar o limite no meio interrompe os runs ativos do escopo, bloqueia as tasks e bloqueia novos runs. **Auditoria**: eventos encadeados por SHA-256 (runs, aprovações, hooks, configurações, segredos sem valor), verificação de integridade e exportação JSONL. |
| Configurações | Checagem do ambiente (Node, runtime, login do Claude Code), autenticação padrão, tema, notificações e menu bar, atalhos de teclado, atualizações assinadas, backup local das configurações (exportar/importar, cópias automáticas, restaurar com prévia), refazer onboarding. **Board e delegação**: devoluções por agentes antes de subir para você, tasks abertas por membro, turnos de um run de revisão, resumo executivo do relatório (herdar / desligado / Haiku). **Sobre**: versão do Octopus (também no rodapé da sidebar), runtime, SDK, protocolo e atualizações. |
| Menu bar | Ícone sempre visível com o número de runs ativos e um ponto quando há aprovação ou task esperando você; menu com os runs, atalhos para Aprovações e Board, pausar o scheduler e sair. Notificações do macOS para aprovações, tasks e (opcional) fim de run, só com a janela fora de foco. |

## Build e distribuição (.app / .dmg / atualizações)

```bash
npm run build:app
```

O script `scripts/build-app.mjs` roda `tauri build` e gera `Octopus AI.app` e o `.dmg` em `apps/desktop/src-tauri/target/release/bundle/`. Antes, `scripts/build-sidecar-binary.mjs` transforma o sidecar num binário único (esbuild + Node SEA + `postject`) e copia o Claude Code nativo do SDK; os dois entram em `Contents/MacOS/` como `externalBin` (`agent-runtime` e `claude`), com entitlements de JIT para o V8 sob hardened runtime. O Node embutido precisa ser autossuficiente: o do Homebrew liga com bibliotecas de `/opt/homebrew` e é recusado pelo script; baixe o oficial de nodejs.org (confira o `SHASUMS256.txt`) e rode `OCTOPUS_SEA_NODE=<pasta>/bin/node npm run build:app`. Resultado em 20/10/2026: `.app` de 368 MB e `.dmg` de 146 MB (o `claude` nativo é 239 MB disso). Quem instala o app não precisa de Node; o login do Claude Code (ou uma API key) continua pré-requisito. `OCTOPUS_SIDECAR=node npm run build:app` volta ao modo antigo: o sidecar com as dependências em `Contents/Resources/sidecar/`, rodando com o `node` da máquina (PATH, Homebrew, instalador oficial, Volta, nvm ou `OCTOPUS_NODE`).

- **Atualizações assinadas**: com a chave em `~/.tauri/octopus-updater.key` (fora do repositório; a pública está em `tauri.conf.json`), o build gera `release/` com o `.app.tar.gz`, a assinatura e o `latest.json`. Publique a pasta num host estático e informe a URL do `latest.json` em Configurações → Atualizações. `OCTOPUS_RELEASE_BASE_URL` define a URL base dos pacotes no manifesto. Sem a chave, o build sai sem artefatos de update.
- **Assinatura de código**: por padrão ad-hoc (uso local; na primeira abertura, botão direito → Abrir). Para distribuir a terceiros, defina `APPLE_SIGNING_IDENTITY="Developer ID Application: …"` e, para notarizar, `APPLE_ID`, `APPLE_PASSWORD` (senha de app) e `APPLE_TEAM_ID` antes do build.
- **Menu bar**: fechar a janela não encerra o app; os runs continuam e o ícone na menu bar mostra o que está ativo. Saia pelo menu do ícone.

## Onde ficam os dados

`~/Library/Application Support/ai.octopus.desktop/octopus.db` (SQLite). As sessões do Claude continuam em `~/.claude/projects/`.

## Variáveis úteis

| Variável | Efeito |
|---|---|
| `OCTOPUS_SIDECAR_PROGRAM` / `OCTOPUS_SIDECAR_ARGS` | Força o comando do sidecar (ex.: `node` + caminho do `main.js`). |
| `OCTOPUS_CLAUDE_PATH` | Força o Claude Code nativo que o sidecar executa (no binário único ele usa o `claude` ao lado). |
| `OCTOPUS_SIDECAR=node` | No `npm run build:app`, empacota o sidecar no modo antigo (resources + node da máquina). |
| `OCTOPUS_SEA_NODE` | No `npm run build:app`, o Node oficial (estático) que vai dentro do binário único. |
| `RUST_LOG` | Filtro de logs do core (padrão `info,octopus_desktop_lib=debug`). |
| `OCTOPUS_SECRETS=memory` | Guarda as API keys em memória em vez do Keychain (testes/CI). |
| `ANTHROPIC_API_KEY` | Não precisa estar no ambiente: para projetos em modo `api_key`, o core lê a chave do Keychain (serviço `ai.octopus.desktop`) e a injeta só na chamada ao sidecar. |

## Aviso de licença

O login do claude.ai (assinatura) só pode ser usado para uso próprio. Para distribuir o app a terceiros, use API key.
