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
