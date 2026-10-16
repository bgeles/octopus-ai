//! Espelho em Rust do protocolo definido em `packages/protocol/src/index.ts`.
//!
//! A fonte da verdade é o pacote TypeScript. Os testes deste módulo deserializam as
//! fixtures compartilhadas em `packages/protocol/fixtures` para garantir que os dois
//! lados concordam.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// Primitivos
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PermissionMode {
    #[serde(rename = "default")]
    Default,
    #[serde(rename = "acceptEdits")]
    AcceptEdits,
    #[serde(rename = "plan")]
    Plan,
    #[serde(rename = "dontAsk")]
    DontAsk,
    #[serde(rename = "auto")]
    Auto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SettingSource {
    User,
    Project,
    Local,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_tokens: u64,
    #[serde(default)]
    pub cache_creation_tokens: u64,
}

impl Usage {
    /// Estimativa do contexto ocupado: tudo que entrou no último turno.
    pub fn context_tokens(&self) -> u64 {
        self.input_tokens + self.cache_read_tokens + self.cache_creation_tokens
    }
}

// ---------------------------------------------------------------------------
// Opções de run
// ---------------------------------------------------------------------------

/// Subagente programático (`options.agents` do SDK).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinition {
    pub description: String,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatusUpdate {
    Done,
    Review,
    Blocked,
}

/// Run que executa uma task do board: o sidecar expõe a tool `task_update` ao agente.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskContext {
    pub task_id: String,
    pub title: String,
    pub stage: String,
    #[serde(default)]
    pub allowed_statuses: Vec<TaskStatusUpdate>,
}

/// Subconjunto do `SandboxSettings` do SDK controlado pelos perfis de sandbox.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SandboxSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fail_if_unavailable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_unsandboxed_commands: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_allow_bash_if_sandboxed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network: Option<SandboxNetwork>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filesystem: Option<SandboxFilesystem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credentials: Option<SandboxCredentials>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SandboxNetwork {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_domains: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub denied_domains: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strict_allowlist: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SandboxFilesystem {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_write: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deny_write: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deny_read: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_read: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SandboxCredentials {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env_vars: Option<Vec<SandboxEnvVar>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxEnvVar {
    pub name: String,
    /// `deny` ou `mask`.
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inject_hosts: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_budget_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fork_session: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt_append: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_tools: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setting_sources: Option<Vec<SettingSource>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<std::collections::BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_partial_messages: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agents: Option<std::collections::BTreeMap<String, AgentDefinition>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_context: Option<TaskContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy_hooks: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<SandboxSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<MemoryOptions>,
}

/// Captura de memória por hooks do SDK.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryOptions {
    #[serde(default = "default_true")]
    pub capture: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief_items: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<bool>,
}

fn default_true() -> bool {
    true
}

impl Default for MemoryOptions {
    fn default() -> Self {
        Self {
            capture: true,
            brief: None,
            brief_items: None,
            tools: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryOp {
    Search,
    Write,
    Handoff,
}

/// Notificação `run.memory_call`: o agente chamou uma tool de memória; o core responde com `memory.result`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunMemoryCallNotification {
    pub run_id: String,
    pub call_id: String,
    pub op: MemoryOp,
    #[serde(default)]
    pub args: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryCallResult {
    pub ok: bool,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryResultParams {
    pub run_id: String,
    pub call_id: String,
    pub result: MemoryCallResult,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryResultResult {
    pub applied: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservationKind {
    ToolUse,
    TurnEnd,
    SubagentEnd,
    SessionEnd,
}

impl ObservationKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ObservationKind::ToolUse => "tool_use",
            ObservationKind::TurnEnd => "turn_end",
            ObservationKind::SubagentEnd => "subagent_end",
            ObservationKind::SessionEnd => "session_end",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionPhase {
    Pre,
    Post,
}

// ---------------------------------------------------------------------------
// Requests Rust -> sidecar
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloParams {
    pub protocol_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloResult {
    pub protocol_version: u32,
    pub runtime_version: String,
    pub sdk_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStartParams {
    pub run_id: String,
    pub cwd: String,
    pub prompt: String,
    #[serde(default)]
    pub options: RunOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunStartResult {
    pub accepted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunInterruptParams {
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunInterruptResult {
    pub interrupted: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "behavior", rename_all = "lowercase")]
pub enum PermissionDecision {
    #[serde(rename_all = "camelCase")]
    Allow {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        updated_input: Option<Value>,
    },
    Deny {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDecideParams {
    pub run_id: String,
    pub request_id: String,
    pub decision: PermissionDecision,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionDecideResult {
    pub applied: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionsListParams {
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    pub cwd: String,
    pub title: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub created_at: Option<String>,
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionsListResult {
    pub sessions: Vec<SessionSummary>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsRenameParams {
    pub session_id: String,
    pub cwd: String,
    pub title: String,
}

/// `tag: None` serializa como `null` e remove a tag no SDK.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsTagParams {
    pub session_id: String,
    pub cwd: String,
    pub tag: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMutationResult {
    pub ok: bool,
}

/// Decisão do core para um hook PreToolUse: `allow`, `deny`, `ask` ou `pass`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookDecision {
    pub behavior: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_input: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookDecideParams {
    pub run_id: String,
    pub hook_id: String,
    pub decision: HookDecision,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookDecideResult {
    pub applied: bool,
}

/// Notificação `run.hook`: o sidecar segura a ferramenta até o `hook.decide`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunHookNotification {
    pub run_id: String,
    pub hook_id: String,
    pub event: String,
    pub tool_name: String,
    pub input: Value,
    #[serde(default)]
    pub tool_use_id: Option<String>,
    #[serde(default)]
    pub parent_tool_use_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Eventos de run (sidecar -> Rust -> UI)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerStatus {
    pub name: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RunEvent {
    #[serde(rename_all = "camelCase")]
    SessionInit {
        session_id: String,
        model: String,
        #[serde(default)]
        tools: Vec<String>,
        #[serde(default)]
        mcp_servers: Vec<McpServerStatus>,
        #[serde(default)]
        permission_mode: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    AssistantText {
        #[serde(default)]
        message_id: Option<String>,
        text: String,
        #[serde(default)]
        parent_tool_use_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    AssistantTextDelta {
        text: String,
        #[serde(default)]
        parent_tool_use_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    ToolUse {
        tool_use_id: String,
        name: String,
        input: Value,
        #[serde(default)]
        parent_tool_use_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    ToolResult {
        tool_use_id: String,
        content: String,
        #[serde(default)]
        is_error: bool,
        #[serde(default)]
        parent_tool_use_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Usage {
        usage: Usage,
        #[serde(default)]
        context_window: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    PermissionRequest {
        request_id: String,
        tool_name: String,
        input: Value,
        #[serde(default)]
        reason: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Result {
        session_id: String,
        subtype: String,
        is_error: bool,
        #[serde(default)]
        cost_usd: Option<f64>,
        #[serde(default)]
        duration_ms: Option<u64>,
        #[serde(default)]
        num_turns: Option<u32>,
        #[serde(default)]
        usage: Option<Usage>,
        #[serde(default)]
        stop_reason: Option<String>,
        #[serde(default)]
        result_text: Option<String>,
    },
    Error {
        message: String,
        #[serde(default)]
        fatal: bool,
    },
    #[serde(rename_all = "camelCase")]
    TaskUpdate {
        task_id: String,
        status: TaskStatusUpdate,
        #[serde(default)]
        note: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Observation {
        kind: ObservationKind,
        title: String,
        body: String,
        #[serde(default)]
        tool_name: Option<String>,
        #[serde(default)]
        tool_use_id: Option<String>,
        #[serde(default)]
        parent_tool_use_id: Option<String>,
        #[serde(default)]
        agent_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Compaction {
        phase: CompactionPhase,
        trigger: String,
        #[serde(default)]
        summary: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    BriefInjected {
        chars: u64,
        #[serde(default)]
        items: Vec<String>,
    },
}

impl RunEvent {
    /// Nome estável do tipo, igual ao discriminador `type` no JSON.
    pub fn kind(&self) -> &'static str {
        match self {
            RunEvent::SessionInit { .. } => "session_init",
            RunEvent::AssistantText { .. } => "assistant_text",
            RunEvent::AssistantTextDelta { .. } => "assistant_text_delta",
            RunEvent::ToolUse { .. } => "tool_use",
            RunEvent::ToolResult { .. } => "tool_result",
            RunEvent::Usage { .. } => "usage",
            RunEvent::PermissionRequest { .. } => "permission_request",
            RunEvent::Result { .. } => "result",
            RunEvent::Error { .. } => "error",
            RunEvent::TaskUpdate { .. } => "task_update",
            RunEvent::Observation { .. } => "observation",
            RunEvent::Compaction { .. } => "compaction",
            RunEvent::BriefInjected { .. } => "brief_injected",
        }
    }

    /// Deltas de texto são efêmeros: vão para a UI mas não para o banco.
    pub fn is_persistent(&self) -> bool {
        !matches!(self, RunEvent::AssistantTextDelta { .. })
    }

    /// Indica que o run terminou (com ou sem sucesso).
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            RunEvent::Result { .. } | RunEvent::Error { fatal: true, .. }
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEventNotification {
    pub run_id: String,
    pub seq: u64,
    pub at: String,
    pub event: RunEvent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeLog {
    pub level: String,
    pub message: String,
}

// ---------------------------------------------------------------------------
// Envelopes JSON-RPC 2.0
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum JsonRpcId {
    Number(i64),
    String(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: JsonRpcId,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

impl JsonRpcRequest {
    pub fn new(id: JsonRpcId, method: &str, params: impl Serialize) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            method: method.into(),
            params: Some(serde_json::to_value(params).expect("params serializáveis")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// Qualquer linha que o sidecar escreve: resposta a um request ou notificação.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum IncomingMessage {
    Response {
        id: JsonRpcId,
        #[serde(default)]
        result: Option<Value>,
        #[serde(default)]
        error: Option<JsonRpcError>,
    },
    Notification {
        method: String,
        #[serde(default)]
        params: Option<Value>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixtures_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/protocol/fixtures")
    }

    fn read_fixture(name: &str) -> Value {
        let path = fixtures_dir().join(name);
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("lendo {}: {e}", path.display()));
        serde_json::from_str(&text).expect("fixture é JSON válido")
    }

    #[test]
    fn run_start_fixture_roundtrips() {
        let raw = read_fixture("run-start.request.json");
        let request: JsonRpcRequest = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(request.method, "run.start");
        let params: RunStartParams =
            serde_json::from_value(request.params.clone().unwrap()).unwrap();
        assert_eq!(params.run_id, "run_01HZX9R2Y3");
        assert_eq!(
            params.options.permission_mode,
            Some(PermissionMode::Default)
        );
        assert_eq!(
            params.options.setting_sources,
            Some(vec![SettingSource::Project])
        );
        let agents = params.options.agents.as_ref().unwrap();
        assert_eq!(
            agents["teo"].tools.as_ref().unwrap(),
            &vec!["Read".to_string(), "Bash".to_string()]
        );

        // Serializar de volta deve produzir o mesmo JSON (modulo campos omitidos).
        let again = serde_json::to_value(&params).unwrap();
        assert_eq!(again, raw["params"]);
    }

    #[test]
    fn permission_decide_fixture_parses() {
        let raw = read_fixture("permission-decide.request.json");
        let request: JsonRpcRequest = serde_json::from_value(raw).unwrap();
        assert_eq!(request.id, JsonRpcId::String("req-7".into()));
        let params: PermissionDecideParams =
            serde_json::from_value(request.params.unwrap()).unwrap();
        assert_eq!(
            params.decision,
            PermissionDecision::Deny {
                message: "Rede bloqueada pelo perfil de sandbox estrito".into()
            }
        );
    }

    #[test]
    fn sessions_request_fixtures_roundtrip() {
        let raw = read_fixture("sessions-list.request.json");
        let request: JsonRpcRequest = serde_json::from_value(raw).unwrap();
        assert_eq!(request.method, "sessions.list");
        let params: SessionsListParams = serde_json::from_value(request.params.unwrap()).unwrap();
        assert_eq!(params.cwd, "/Users/dev/projetos/chat-core");

        let raw = read_fixture("sessions-rename.request.json");
        let request: JsonRpcRequest = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(request.method, "sessions.rename");
        let params: SessionsRenameParams = serde_json::from_value(request.params.unwrap()).unwrap();
        assert_eq!(params.title, "Migração V12: tabela leads");
        assert_eq!(serde_json::to_value(&params).unwrap(), raw["params"]);

        let raw = read_fixture("sessions-tag.request.json");
        let request: JsonRpcRequest = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(request.method, "sessions.tag");
        let params: SessionsTagParams = serde_json::from_value(request.params.unwrap()).unwrap();
        assert_eq!(params.tag, None);
        // `None` precisa virar `null` explícito, não ser omitido: o sidecar exige a chave.
        assert_eq!(serde_json::to_value(&params).unwrap(), raw["params"]);
    }

    #[test]
    fn hook_fixtures_roundtrip() {
        let raw = read_fixture("hook-decide.request.json");
        let request: JsonRpcRequest = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(request.method, "hook.decide");
        let params: HookDecideParams = serde_json::from_value(request.params.unwrap()).unwrap();
        assert_eq!(params.decision.behavior, "deny");
        assert_eq!(serde_json::to_value(&params).unwrap(), raw["params"]);

        let raw = read_fixture("run-hook.notifications.json");
        let item = &raw.as_array().unwrap()[0];
        match serde_json::from_value::<IncomingMessage>(item.clone()).unwrap() {
            IncomingMessage::Notification { method, params } => {
                assert_eq!(method, "run.hook");
                let n: RunHookNotification = serde_json::from_value(params.unwrap()).unwrap();
                assert_eq!(n.tool_name, "Bash");
                assert_eq!(n.input["command"], "rm -rf /tmp/x");
                assert_eq!(n.tool_use_id.as_deref(), Some("toolu_09"));
            }
            _ => panic!("esperava notificação"),
        }

        let sandbox = SandboxSettings {
            enabled: Some(true),
            filesystem: Some(SandboxFilesystem {
                allow_write: Some(vec!["/p".into()]),
                ..Default::default()
            }),
            ..Default::default()
        };
        let value = serde_json::to_value(&sandbox).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"enabled": true, "filesystem": {"allowWrite": ["/p"]}})
        );
    }

    #[test]
    fn run_event_fixtures_parse_as_notifications() {
        let raw = read_fixture("run-events.notifications.json");
        let list = raw.as_array().expect("lista");
        let mut kinds = Vec::new();
        for item in list {
            let incoming: IncomingMessage = serde_json::from_value(item.clone()).unwrap();
            match incoming {
                IncomingMessage::Notification { method, params } => {
                    assert_eq!(method, "run.event");
                    let notification: RunEventNotification =
                        serde_json::from_value(params.unwrap()).unwrap();
                    assert_eq!(notification.run_id, "run_01HZX9R2Y3");
                    kinds.push(notification.event.kind());
                }
                IncomingMessage::Response { .. } => panic!("fixture deveria ser notificação"),
            }
        }
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
    }

    #[test]
    fn memory_fixture_parses_observations_and_compaction() {
        let raw = read_fixture("run-events-memory.notifications.json");
        let mut observations = 0;
        let mut post_summary = None;
        for item in raw.as_array().unwrap() {
            let incoming: IncomingMessage = serde_json::from_value(item.clone()).unwrap();
            if let IncomingMessage::Notification { params, .. } = incoming {
                let n: RunEventNotification = serde_json::from_value(params.unwrap()).unwrap();
                match &n.event {
                    RunEvent::Observation { kind, title, .. } => {
                        observations += 1;
                        if *kind == ObservationKind::SubagentEnd {
                            assert!(title.contains("Subagente"));
                        }
                    }
                    RunEvent::Compaction {
                        phase: CompactionPhase::Post,
                        summary,
                        ..
                    } => post_summary = summary.clone(),
                    _ => {}
                }
            }
        }
        assert_eq!(observations, 5);
        assert!(post_summary.unwrap().contains("V12"));
        let brief = raw
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| serde_json::from_value::<IncomingMessage>(item.clone()).ok())
            .find_map(|m| match m {
                IncomingMessage::Notification { params, .. } => {
                    let n: RunEventNotification = serde_json::from_value(params.unwrap()).unwrap();
                    match n.event {
                        RunEvent::BriefInjected { chars, items } => Some((chars, items)),
                        _ => None,
                    }
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(brief.0, 1840);
        assert_eq!(brief.1.len(), 3);

        // Chamadas de memória e a resposta do core.
        let calls = read_fixture("run-memory-call.notifications.json");
        let mut ops = Vec::new();
        for item in calls.as_array().unwrap() {
            let incoming: IncomingMessage = serde_json::from_value(item.clone()).unwrap();
            if let IncomingMessage::Notification { method, params } = incoming {
                assert_eq!(method, "run.memory_call");
                let n: RunMemoryCallNotification = serde_json::from_value(params.unwrap()).unwrap();
                ops.push(n.op);
            }
        }
        assert_eq!(
            ops,
            vec![MemoryOp::Search, MemoryOp::Write, MemoryOp::Handoff]
        );
        let res = read_fixture("memory-result.request.json");
        let params: MemoryResultParams = serde_json::from_value(res["params"].clone()).unwrap();
        assert!(params.result.ok);
        let roundtrip = serde_json::to_value(&params).unwrap();
        assert_eq!(roundtrip, res["params"]);
        let opts: RunOptions =
            serde_json::from_value(serde_json::json!({"memory": {"brief": "x", "tools": true}}))
                .unwrap();
        assert_eq!(opts.memory.as_ref().unwrap().tools, Some(true));
        assert!(opts.memory.unwrap().capture);
        let opts: RunOptions = serde_json::from_value(serde_json::json!({"memory": {}})).unwrap();
        assert!(opts.memory.unwrap().capture);
    }

    #[test]
    fn task_fixture_parses_task_update() {
        let raw = read_fixture("run-events-task.notifications.json");
        let mut kinds = Vec::new();
        for item in raw.as_array().unwrap() {
            let incoming: IncomingMessage = serde_json::from_value(item.clone()).unwrap();
            if let IncomingMessage::Notification { params, .. } = incoming {
                let n: RunEventNotification = serde_json::from_value(params.unwrap()).unwrap();
                if let RunEvent::TaskUpdate {
                    task_id,
                    status,
                    note,
                } = &n.event
                {
                    assert_eq!(task_id, "task_01");
                    assert_eq!(*status, TaskStatusUpdate::Review);
                    assert!(note.as_deref().unwrap().contains("V12"));
                }
                kinds.push(n.event.kind());
            }
        }
        assert!(kinds.contains(&"task_update"));
        let ctx = TaskContext {
            task_id: "t".into(),
            title: "x".into(),
            stage: "Implementar".into(),
            allowed_statuses: vec![TaskStatusUpdate::Done],
        };
        let value = serde_json::to_value(&ctx).unwrap();
        assert_eq!(value["allowedStatuses"][0], "done");
        assert_eq!(value["taskId"], "t");
    }

    #[test]
    fn run_event_serializes_with_type_tag() {
        let event = RunEvent::ToolUse {
            tool_use_id: "t1".into(),
            name: "Read".into(),
            input: serde_json::json!({"file_path": "a"}),
            parent_tool_use_id: None,
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["type"], "tool_use");
        assert_eq!(value["toolUseId"], "t1");
        assert!(value["parentToolUseId"].is_null());
    }

    #[test]
    fn permission_decision_allow_serializes_behavior_tag() {
        let allow = PermissionDecision::Allow {
            updated_input: None,
        };
        assert_eq!(
            serde_json::to_value(&allow).unwrap(),
            serde_json::json!({"behavior": "allow"})
        );
        let deny = PermissionDecision::Deny {
            message: "não".into(),
        };
        assert_eq!(
            serde_json::to_value(&deny).unwrap(),
            serde_json::json!({"behavior": "deny", "message": "não"})
        );
    }

    #[test]
    fn incoming_response_with_error_parses() {
        let raw = serde_json::json!({"jsonrpc": "2.0", "id": 3, "error": {"code": -32001, "message": "Run não encontrado"}});
        match serde_json::from_value::<IncomingMessage>(raw).unwrap() {
            IncomingMessage::Response { id, result, error } => {
                assert_eq!(id, JsonRpcId::Number(3));
                assert!(result.is_none());
                assert_eq!(error.unwrap().code, -32001);
            }
            _ => panic!("esperava resposta"),
        }
    }

    #[test]
    fn terminal_and_persistent_flags() {
        let delta = RunEvent::AssistantTextDelta {
            text: "x".into(),
            parent_tool_use_id: None,
        };
        assert!(!delta.is_persistent());
        assert!(!delta.is_terminal());
        let fatal = RunEvent::Error {
            message: "x".into(),
            fatal: true,
        };
        assert!(fatal.is_terminal());
        let soft = RunEvent::Error {
            message: "x".into(),
            fatal: false,
        };
        assert!(!soft.is_terminal());
    }

    #[test]
    fn usage_context_tokens_sums_inputs() {
        let usage = Usage {
            input_tokens: 10,
            output_tokens: 99,
            cache_read_tokens: 20,
            cache_creation_tokens: 5,
        };
        assert_eq!(usage.context_tokens(), 35);
    }
}
