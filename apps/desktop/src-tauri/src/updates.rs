//! Atualizações (Fase 7): o endereço do manifesto `latest.json` é uma preferência do app
//! (`updates.endpoint`); sem ele o app nunca procura. Os pacotes são verificados com a chave
//! pública embutida em tauri.conf.json antes de instalar.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_updater::UpdaterExt;

use crate::commands::AppState;
use crate::commands_security::audit;

pub const ENDPOINT_SETTING: &str = "updates.endpoint";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub configured: bool,
    pub current_version: String,
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub date: Option<String>,
}

/// Valida o endereço: só https (ou http em localhost, para testes).
pub fn validate_endpoint(raw: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(raw.trim()).map_err(|e| format!("Endereço inválido: {e}"))?;
    let local = matches!(url.host_str(), Some("localhost") | Some("127.0.0.1"));
    if url.scheme() != "https" && !(url.scheme() == "http" && local) {
        return Err("Use https:// (http só em localhost)".into());
    }
    Ok(url)
}

fn endpoint(state: &AppState) -> Result<Option<url::Url>, String> {
    let raw = state
        .store
        .get_setting(ENDPOINT_SETTING)
        .map_err(|e| e.to_string())?
        .and_then(|v| v.as_str().map(str::to_string))
        .filter(|s| !s.trim().is_empty());
    raw.map(|r| validate_endpoint(&r)).transpose()
}

#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let Some(url) = endpoint(&state)? else {
        return Ok(UpdateInfo {
            configured: false,
            current_version: current,
            available: false,
            version: None,
            notes: None,
            date: None,
        });
    };
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("Não consegui verificar: {e}"))?;
    Ok(match update {
        Some(u) => UpdateInfo {
            configured: true,
            current_version: current,
            available: true,
            version: Some(u.version.clone()),
            notes: u.body.clone(),
            date: u.date.map(|d| d.to_string()),
        },
        None => UpdateInfo {
            configured: true,
            current_version: current,
            available: false,
            version: None,
            notes: None,
            date: None,
        },
    })
}

/// Baixa, verifica a assinatura, instala e reinicia o app.
#[tauri::command]
pub async fn install_update(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let url = endpoint(&state)?.ok_or("Atualizações não configuradas")?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("Não consegui verificar: {e}"))?
        .ok_or("Nenhuma atualização disponível")?;
    let version = update.version.clone();
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| format!("Falha ao instalar: {e}"))?;
    audit(
        &state,
        "você",
        "app.updated",
        None,
        serde_json::json!({"version": version}),
    );
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_validation() {
        assert!(validate_endpoint("https://releases.empresa.com/octopus/latest.json").is_ok());
        assert!(validate_endpoint("http://localhost:8080/latest.json").is_ok());
        assert!(validate_endpoint("http://releases.empresa.com/latest.json").is_err());
        assert!(validate_endpoint("ftp://x/latest.json").is_err());
        assert!(validate_endpoint("não é url").is_err());
    }
}
