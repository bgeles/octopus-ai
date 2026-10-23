//! Supervisor do sidecar Node (`@octopus/agent-runtime`).
//!
//! Sobe o processo, fala JSON-RPC 2.0 em NDJSON pelo stdio e separa:
//! - respostas a requests (correlacionadas por `id` com canais oneshot);
//! - notificações (`run.event`, `runtime.log`), entregues por um canal mpsc.
//!
//! O módulo não conhece Tauri: `lib.rs` liga as notificações aos eventos da janela.

pub mod command;

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, bail, Context, Result};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, error, info, warn};

use crate::protocol::*;
pub use command::SidecarCommand;

#[derive(Debug, Clone)]
pub enum SidecarNotification {
    RunEvent(RunEventNotification),
    /// Hook PreToolUse bloqueante: o core precisa responder com `decide_hook`.
    Hook(RunHookNotification),
    /// Tool de memória chamada pelo agente: o core responde com `memory_result`.
    MemoryCall(RunMemoryCallNotification),
    /// Tool de delegação (board) chamada pelo agente: o core valida e responde com `board_result`.
    BoardCall(RunBoardCallNotification),
    Log(RuntimeLog),
    /// O processo terminou (código de saída, se houver).
    Exited(Option<i32>),
}

type PendingMap =
    Arc<Mutex<HashMap<i64, oneshot::Sender<std::result::Result<Value, JsonRpcError>>>>>;

pub struct Sidecar {
    /// `None` depois de `shutdown()`: soltar o handle fecha o pipe e o sidecar encerra.
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    pending: PendingMap,
    next_id: AtomicI64,
    child: Mutex<Option<Child>>,
}

impl Sidecar {
    /// Inicia o processo e retorna o handle mais o canal de notificações.
    pub async fn spawn(
        command: SidecarCommand,
    ) -> Result<(Arc<Self>, mpsc::Receiver<SidecarNotification>)> {
        info!(program = %command.program, args = ?command.args, "iniciando sidecar");
        let mut child = command
            .to_tokio()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("não foi possível iniciar o sidecar `{}`", command.program))?;

        let stdin = child.stdin.take().context("sidecar sem stdin")?;
        let stdout = child.stdout.take().context("sidecar sem stdout")?;
        let stderr = child.stderr.take().context("sidecar sem stderr")?;

        let (notify_tx, notify_rx) = mpsc::channel::<SidecarNotification>(1024);
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));

        // stderr -> tracing
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                debug!(target: "sidecar::stderr", "{line}");
            }
        });

        // stdout -> respostas e notificações
        {
            let pending = pending.clone();
            let notify_tx = notify_tx.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => dispatch_line(&line, &pending, &notify_tx).await,
                        Ok(None) => break,
                        Err(e) => {
                            warn!("erro lendo stdout do sidecar: {e}");
                            break;
                        }
                    }
                }
                // Falha todos os requests pendentes.
                let mut map = pending.lock().expect("pending mutex");
                for (_, tx) in map.drain() {
                    let _ = tx.send(Err(JsonRpcError {
                        code: -32000,
                        message: "sidecar encerrou".into(),
                        data: None,
                    }));
                }
            });
        }

        let sidecar = Arc::new(Self {
            stdin: tokio::sync::Mutex::new(Some(stdin)),
            pending,
            next_id: AtomicI64::new(1),
            child: Mutex::new(Some(child)),
        });

        // Observa o término do processo.
        {
            let sidecar = sidecar.clone();
            tokio::spawn(async move {
                let child = sidecar.child.lock().expect("child mutex").take();
                if let Some(mut child) = child {
                    let status = child.wait().await.ok();
                    let code = status.and_then(|s| s.code());
                    warn!(?code, "sidecar terminou");
                    let _ = notify_tx.send(SidecarNotification::Exited(code)).await;
                }
            });
        }

        Ok((sidecar, notify_rx))
    }

    pub async fn request<P: Serialize, R: DeserializeOwned>(
        &self,
        method: &str,
        params: P,
    ) -> Result<R> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().expect("pending mutex").insert(id, tx);

        let request = JsonRpcRequest::new(JsonRpcId::Number(id), method, params);
        let mut line = serde_json::to_string(&request)?;
        line.push('\n');
        {
            let mut guard = self.stdin.lock().await;
            let Some(stdin) = guard.as_mut() else {
                self.pending.lock().expect("pending mutex").remove(&id);
                bail!("sidecar já foi encerrado");
            };
            if let Err(e) = stdin.write_all(line.as_bytes()).await {
                self.pending.lock().expect("pending mutex").remove(&id);
                bail!("falha escrevendo para o sidecar: {e}");
            }
            stdin.flush().await?;
        }

        let outcome = tokio::time::timeout(std::time::Duration::from_secs(60), rx)
            .await
            .map_err(|_| anyhow!("timeout aguardando resposta de {method}"))?
            .map_err(|_| anyhow!("canal de resposta fechado para {method}"))?;
        match outcome {
            Ok(value) => serde_json::from_value(value)
                .with_context(|| format!("resposta inválida de {method}")),
            Err(err) => Err(anyhow!("{method} falhou ({}): {}", err.code, err.message)),
        }
    }

    pub async fn hello(&self) -> Result<HelloResult> {
        let result: HelloResult = self
            .request(
                "runtime.hello",
                HelloParams {
                    protocol_version: PROTOCOL_VERSION,
                },
            )
            .await?;
        if result.protocol_version != PROTOCOL_VERSION {
            bail!(
                "sidecar fala protocolo v{}, esperado v{}",
                result.protocol_version,
                PROTOCOL_VERSION
            );
        }
        Ok(result)
    }

    pub async fn start_run(&self, params: RunStartParams) -> Result<RunStartResult> {
        self.request("run.start", params).await
    }

    pub async fn interrupt_run(&self, run_id: &str) -> Result<RunInterruptResult> {
        self.request(
            "run.interrupt",
            RunInterruptParams {
                run_id: run_id.into(),
            },
        )
        .await
    }

    pub async fn decide_permission(
        &self,
        params: PermissionDecideParams,
    ) -> Result<PermissionDecideResult> {
        self.request("permission.decide", params).await
    }

    pub async fn decide_hook(&self, params: HookDecideParams) -> Result<HookDecideResult> {
        self.request("hook.decide", params).await
    }

    pub async fn memory_result(&self, params: MemoryResultParams) -> Result<MemoryResultResult> {
        self.request("memory.result", params).await
    }

    pub async fn board_result(&self, params: BoardResultParams) -> Result<BoardResultResult> {
        self.request("board.result", params).await
    }

    pub async fn hooks_test(&self, params: HooksTestParams) -> Result<HookRunResult> {
        self.request("hooks.test", params).await
    }

    pub async fn mcp_check(&self, params: McpCheckParams) -> Result<McpCheckResult> {
        self.request("mcp.check", params).await
    }

    pub async fn list_sessions(&self, cwd: &str) -> Result<SessionsListResult> {
        self.request("sessions.list", SessionsListParams { cwd: cwd.into() })
            .await
    }

    pub async fn rename_session(
        &self,
        params: SessionsRenameParams,
    ) -> Result<SessionMutationResult> {
        self.request("sessions.rename", params).await
    }

    pub async fn tag_session(&self, params: SessionsTagParams) -> Result<SessionMutationResult> {
        self.request("sessions.tag", params).await
    }

    /// Fecha o stdin (soltando o handle), o que faz o sidecar encerrar os runs e sair.
    pub async fn shutdown(&self) {
        let mut guard = self.stdin.lock().await;
        if let Some(mut stdin) = guard.take() {
            let _ = stdin.flush().await;
            drop(stdin);
        }
    }
}

/// Interpreta uma linha do stdout do sidecar.
pub fn decode_line(line: &str) -> Result<IncomingMessage> {
    serde_json::from_str::<IncomingMessage>(line)
        .with_context(|| format!("linha inválida do sidecar: {line}"))
}

async fn dispatch_line(
    line: &str,
    pending: &PendingMap,
    notify_tx: &mpsc::Sender<SidecarNotification>,
) {
    if line.trim().is_empty() {
        return;
    }
    let message = match decode_line(line) {
        Ok(m) => m,
        Err(e) => {
            warn!("{e}");
            return;
        }
    };
    match message {
        IncomingMessage::Response { id, result, error } => {
            let JsonRpcId::Number(id) = id else {
                warn!("resposta com id não numérico ignorada");
                return;
            };
            let sender = pending.lock().expect("pending mutex").remove(&id);
            match sender {
                Some(tx) => {
                    let payload = match error {
                        Some(err) => Err(err),
                        None => Ok(result.unwrap_or(Value::Null)),
                    };
                    let _ = tx.send(payload);
                }
                None => warn!(id, "resposta sem request pendente"),
            }
        }
        IncomingMessage::Notification { method, params } => match method.as_str() {
            "run.event" => {
                match serde_json::from_value::<RunEventNotification>(params.unwrap_or(Value::Null))
                {
                    Ok(n) => {
                        let _ = notify_tx.send(SidecarNotification::RunEvent(n)).await;
                    }
                    Err(e) => error!("run.event inválido: {e}"),
                }
            }
            "run.hook" => {
                match serde_json::from_value::<RunHookNotification>(params.unwrap_or(Value::Null)) {
                    Ok(n) => {
                        let _ = notify_tx.send(SidecarNotification::Hook(n)).await;
                    }
                    Err(e) => error!("run.hook inválido: {e}"),
                }
            }
            "run.memory_call" => {
                match serde_json::from_value::<RunMemoryCallNotification>(
                    params.unwrap_or(Value::Null),
                ) {
                    Ok(n) => {
                        let _ = notify_tx.send(SidecarNotification::MemoryCall(n)).await;
                    }
                    Err(e) => error!("run.memory_call inválido: {e}"),
                }
            }
            "run.board_call" => {
                match serde_json::from_value::<RunBoardCallNotification>(
                    params.unwrap_or(Value::Null),
                ) {
                    Ok(n) => {
                        let _ = notify_tx.send(SidecarNotification::BoardCall(n)).await;
                    }
                    Err(e) => error!("run.board_call inválido: {e}"),
                }
            }
            "runtime.log" => {
                if let Ok(log) = serde_json::from_value::<RuntimeLog>(params.unwrap_or(Value::Null))
                {
                    let _ = notify_tx.send(SidecarNotification::Log(log)).await;
                }
            }
            other => debug!("notificação desconhecida ignorada: {other}"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn decode_line_distinguishes_response_and_notification() {
        match decode_line(r#"{"jsonrpc":"2.0","id":4,"result":{"accepted":true}}"#).unwrap() {
            IncomingMessage::Response { id, result, error } => {
                assert_eq!(id, JsonRpcId::Number(4));
                assert_eq!(result.unwrap()["accepted"], true);
                assert!(error.is_none());
            }
            _ => panic!("esperava resposta"),
        }
        match decode_line(
            r#"{"jsonrpc":"2.0","method":"runtime.log","params":{"level":"info","message":"oi"}}"#,
        )
        .unwrap()
        {
            IncomingMessage::Notification { method, .. } => assert_eq!(method, "runtime.log"),
            _ => panic!("esperava notificação"),
        }
        assert!(decode_line("{nope").is_err());
    }

    fn fake_sidecar_command() -> Option<SidecarCommand> {
        let script =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_sidecar.mjs");
        let node = which_node()?;
        Some(SidecarCommand::new(
            node,
            vec![script.to_string_lossy().into_owned()],
        ))
    }

    fn which_node() -> Option<String> {
        std::process::Command::new("node")
            .arg("--version")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|_| "node".to_string())
    }

    #[tokio::test]
    async fn talks_to_fake_sidecar_end_to_end() {
        let Some(command) = fake_sidecar_command() else {
            eprintln!("node não encontrado; pulando teste de integração do sidecar");
            return;
        };
        let (sidecar, mut notifications) = Sidecar::spawn(command).await.unwrap();

        let hello = sidecar.hello().await.unwrap();
        assert_eq!(hello.protocol_version, PROTOCOL_VERSION);
        assert_eq!(hello.runtime_version, "fake");

        let accepted = sidecar
            .start_run(RunStartParams {
                run_id: "run_test".into(),
                cwd: "/tmp".into(),
                prompt: "olá".into(),
                options: RunOptions::default(),
            })
            .await
            .unwrap();
        assert!(accepted.accepted);

        // O fake reproduz as fixtures compartilhadas, trocando o runId.
        let mut kinds = Vec::new();
        let mut saw_log = false;
        while let Some(n) =
            tokio::time::timeout(std::time::Duration::from_secs(10), notifications.recv())
                .await
                .unwrap()
        {
            match n {
                SidecarNotification::RunEvent(ev) => {
                    assert_eq!(ev.run_id, "run_test");
                    let terminal = ev.event.is_terminal();
                    kinds.push(ev.event.kind());
                    if terminal {
                        break;
                    }
                }
                SidecarNotification::Log(_) => saw_log = true,
                SidecarNotification::Hook(_) => {}
                SidecarNotification::MemoryCall(_) | SidecarNotification::BoardCall(_) => {}
                SidecarNotification::Exited(_) => panic!("sidecar saiu cedo demais"),
            }
        }
        assert!(saw_log);
        assert_eq!(
            kinds,
            vec![
                "session_init",
                "assistant_text_delta",
                "tool_use",
                "tool_result",
                "permission_request",
                "usage",
                "result"
            ]
        );

        // Sessões: listar, renomear e taguear passam pelo mesmo canal.
        let sessions = sidecar.list_sessions("/tmp").await.unwrap();
        assert_eq!(sessions.sessions.len(), 1);
        assert_eq!(sessions.sessions[0].tags, vec!["teste".to_string()]);
        let renamed = sidecar
            .rename_session(SessionsRenameParams {
                session_id: "5b3f2c1a".into(),
                cwd: "/tmp".into(),
                title: "novo".into(),
            })
            .await
            .unwrap();
        assert!(renamed.ok);
        let tagged = sidecar
            .tag_session(SessionsTagParams {
                session_id: "5b3f2c1a".into(),
                cwd: "/tmp".into(),
                tag: None,
            })
            .await
            .unwrap();
        assert!(tagged.ok);

        // Erro JSON-RPC vira Err com código e mensagem.
        let err = sidecar
            .interrupt_run("inexistente")
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("-32001"), "{err}");

        sidecar.shutdown().await;
        let exited = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while let Some(n) = notifications.recv().await {
                if let SidecarNotification::Exited(code) = n {
                    return code;
                }
            }
            None
        })
        .await
        .unwrap();
        assert_eq!(exited, Some(0));
    }
}
