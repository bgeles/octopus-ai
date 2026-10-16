//! Modelos persistidos. Serializam em camelCase para a UI.

use rusqlite::Row;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::protocol::{RunEvent, RunOptions};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthMode {
    Subscription,
    ApiKey,
}

impl AuthMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            AuthMode::Subscription => "subscription",
            AuthMode::ApiKey => "api_key",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "api_key" => AuthMode::ApiKey,
            _ => AuthMode::Subscription,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub auth_mode: AuthMode,
    pub created_at: String,
}

impl Project {
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Project {
            id: row.get(0)?,
            name: row.get(1)?,
            path: row.get(2)?,
            auth_mode: AuthMode::parse(&row.get::<_, String>(3)?),
            created_at: row.get(4)?,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Queued,
    Running,
    WaitingApproval,
    Completed,
    Failed,
    Interrupted,
}

impl RunStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            RunStatus::Queued => "queued",
            RunStatus::Running => "running",
            RunStatus::WaitingApproval => "waiting_approval",
            RunStatus::Completed => "completed",
            RunStatus::Failed => "failed",
            RunStatus::Interrupted => "interrupted",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "running" => RunStatus::Running,
            "waiting_approval" => RunStatus::WaitingApproval,
            "completed" => RunStatus::Completed,
            "failed" => RunStatus::Failed,
            "interrupted" => RunStatus::Interrupted,
            _ => RunStatus::Queued,
        }
    }

    pub fn is_active(&self) -> bool {
        matches!(
            self,
            RunStatus::Queued | RunStatus::Running | RunStatus::WaitingApproval
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub project_id: String,
    pub prompt: String,
    pub options: RunOptions,
    pub status: RunStatus,
    pub claude_session_id: Option<String>,
    pub model: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub cost_usd: Option<f64>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub num_turns: Option<u32>,
    pub stop_reason: Option<String>,
    pub result_text: Option<String>,
    pub error_message: Option<String>,
}

impl Run {
    pub const SELECT: &'static str = "SELECT id, project_id, prompt, options_json, status, claude_session_id, model, started_at, ended_at,
        cost_usd, input_tokens, output_tokens, cache_read_tokens, num_turns, stop_reason, result_text, error_message FROM run";

    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let options_json: String = row.get(3)?;
        let options: RunOptions = serde_json::from_str(&options_json).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(e))
        })?;
        Ok(Run {
            id: row.get(0)?,
            project_id: row.get(1)?,
            prompt: row.get(2)?,
            options,
            status: RunStatus::parse(&row.get::<_, String>(4)?),
            claude_session_id: row.get(5)?,
            model: row.get(6)?,
            started_at: row.get(7)?,
            ended_at: row.get(8)?,
            cost_usd: row.get(9)?,
            input_tokens: row.get::<_, i64>(10)? as u64,
            output_tokens: row.get::<_, i64>(11)? as u64,
            cache_read_tokens: row.get::<_, i64>(12)? as u64,
            num_turns: row.get::<_, Option<i64>>(13)?.map(|n| n as u32),
            stop_reason: row.get(14)?,
            result_text: row.get(15)?,
            error_message: row.get(16)?,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredRunEvent {
    pub run_id: String,
    pub seq: u64,
    pub at: String,
    pub kind: String,
    pub event: RunEvent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalDecision {
    Allow,
    Deny,
}

impl ApprovalDecision {
    pub fn as_str(&self) -> &'static str {
        match self {
            ApprovalDecision::Allow => "allow",
            ApprovalDecision::Deny => "deny",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "allow" => Some(ApprovalDecision::Allow),
            "deny" => Some(ApprovalDecision::Deny),
            _ => None,
        }
    }
}

/// Pedido de permissão feito pelo agente e, quando houver, a decisão do usuário com o motivo.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub id: String,
    pub run_id: String,
    pub project_id: String,
    pub run_prompt: String,
    pub request_id: String,
    pub tool_name: String,
    pub tool_input: Value,
    pub reason: Option<String>,
    pub decision: Option<ApprovalDecision>,
    pub decision_message: Option<String>,
    pub requested_at: String,
    pub decided_at: Option<String>,
}

impl Approval {
    pub const SELECT: &'static str = "SELECT a.id, a.run_id, r.project_id, r.prompt, a.request_id, a.tool_name, a.tool_input_json,
        a.reason, a.decision, a.decision_message, a.requested_at, a.decided_at FROM approval a JOIN run r ON r.id = a.run_id";

    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let input_json: String = row.get(6)?;
        let tool_input: Value = serde_json::from_str(&input_json).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, Box::new(e))
        })?;
        Ok(Approval {
            id: row.get(0)?,
            run_id: row.get(1)?,
            project_id: row.get(2)?,
            run_prompt: row.get(3)?,
            request_id: row.get(4)?,
            tool_name: row.get(5)?,
            tool_input,
            reason: row.get(7)?,
            decision: row
                .get::<_, Option<String>>(8)?
                .as_deref()
                .and_then(ApprovalDecision::parse),
            decision_message: row.get(9)?,
            requested_at: row.get(10)?,
            decided_at: row.get(11)?,
        })
    }
}
