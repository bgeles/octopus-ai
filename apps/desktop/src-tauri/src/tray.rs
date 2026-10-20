//! Ícone da menu bar e notificações nativas (Fase 7). A lógica do que mostrar fica em
//! `store::attention` (testada); aqui só a ponte com o Tauri.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tracing::warn;

use crate::store::attention::{notification_for, Attention};
use crate::store::Store;

pub const TRAY_ID: &str = "octopus";
/// Evento para a UI trocar de tela (payload: id da view).
pub const NAVIGATE: &str = "app:navigate";

pub fn show_main(app: &AppHandle, view: Option<&str>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    if let Some(view) = view {
        let _ = app.emit(NAVIGATE, view);
    }
}

fn build_menu(app: &AppHandle, a: &Attention) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    let header = match a.active_runs.len() {
        0 => "Octopus · nenhum run ativo".to_string(),
        1 => "Octopus · 1 run ativo".to_string(),
        n => format!("Octopus · {n} runs ativos"),
    };
    menu.append(&MenuItem::with_id(
        app,
        "header",
        header,
        false,
        None::<&str>,
    )?)?;
    for run in a.active_runs.iter().take(8) {
        let label = format!(
            "{}{} · {}",
            if run.waiting_approval { "⏸ " } else { "▶ " },
            run.label,
            run.project_name
        );
        menu.append(&MenuItem::with_id(
            app,
            format!("run:{}", run.run_id),
            label,
            true,
            None::<&str>,
        )?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    if a.pending_approvals > 0 {
        let t = if a.pending_approvals == 1 {
            "1 aprovação pendente".to_string()
        } else {
            format!("{} aprovações pendentes", a.pending_approvals)
        };
        menu.append(&MenuItem::with_id(app, "approvals", t, true, None::<&str>)?)?;
    }
    if a.waiting_tasks > 0 {
        let t = if a.waiting_tasks == 1 {
            "1 task aguardando você".to_string()
        } else {
            format!("{} tasks aguardando você", a.waiting_tasks)
        };
        menu.append(&MenuItem::with_id(app, "board", t, true, None::<&str>)?)?;
    }
    if a.pending_approvals + a.waiting_tasks > 0 {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    menu.append(&MenuItem::with_id(
        app,
        "open",
        "Abrir Octopus",
        true,
        Some("CmdOrCtrl+O"),
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        "pause",
        if a.scheduler_paused {
            "Retomar scheduler"
        } else {
            "Pausar scheduler"
        },
        true,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "quit",
        "Sair do Octopus",
        true,
        Some("CmdOrCtrl+Q"),
    )?)?;
    Ok(menu)
}

/// Cria o ícone (chamado no bootstrap, com o store já aberto).
pub fn install(app: &AppHandle, store: &Store) -> tauri::Result<()> {
    let attention = store.attention().unwrap_or_default();
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&build_menu(app, &attention)?)
        .show_menu_on_left_click(true)
        .tooltip(attention.tooltip())
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            match id {
                "open" => show_main(app, None),
                "approvals" => show_main(app, Some("approvals")),
                "board" => show_main(app, Some("board")),
                "quit" => app.exit(0),
                "pause" => {
                    if let Some(state) = app.try_state::<crate::commands::AppState>() {
                        let paused = state
                            .store
                            .attention()
                            .map(|a| a.scheduler_paused)
                            .unwrap_or(false);
                        if let Err(e) = state.store.set_setting(
                            crate::scheduler::PAUSED_SETTING,
                            &serde_json::json!(!paused),
                        ) {
                            warn!("não alternei a pausa do scheduler: {e}");
                        }
                        refresh(app, &state.store);
                        let _ = app.emit(
                            crate::commands_orchestration::BOARD_CHANGED,
                            serde_json::json!({"paused": !paused}),
                        );
                    }
                }
                other if other.starts_with("run:") => {
                    show_main(app, Some("run"));
                    let _ = app.emit("app:open-run", other.trim_start_matches("run:"));
                }
                _ => {}
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let tray = builder.build(app)?;
    let title = attention.tray_title();
    let _ = tray.set_title(if title.is_empty() { None } else { Some(title) });
    Ok(())
}

/// Atualiza título, dica e menu do ícone com o estado atual.
pub fn refresh(app: &AppHandle, store: &Store) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let attention = match store.attention() {
        Ok(a) => a,
        Err(e) => {
            warn!("menu bar: falha lendo o estado: {e}");
            return;
        }
    };
    let title = attention.tray_title();
    let _ = tray.set_title(if title.is_empty() { None } else { Some(title) });
    let _ = tray.set_tooltip(Some(attention.tooltip()));
    match build_menu(app, &attention) {
        Ok(menu) => {
            let _ = tray.set_menu(Some(menu));
        }
        Err(e) => warn!("menu bar: falha montando o menu: {e}"),
    }
}

/// Mostra a notificação do evento, se as preferências pedirem e a janela não estiver em foco.
/// Runs interrompidos por orçamento: avisa sempre (mesmo com a janela em foco a UI mostra o banner).
pub fn notify_budget_stop(app: &AppHandle, reason: &str) {
    if let Err(e) = app
        .notification()
        .builder()
        .title("Run interrompido por orçamento")
        .body(reason)
        .show()
    {
        warn!("notificação falhou: {e}");
    }
}

pub fn notify(app: &AppHandle, store: &Store, run_id: &str, event: &crate::protocol::RunEvent) {
    let focused = app
        .get_webview_window("main")
        .and_then(|w| Some(w.is_focused().ok()? && w.is_visible().ok()?))
        .unwrap_or(false);
    if focused {
        return;
    }
    let Ok(Some((project, agent, prompt))) = store.run_notification_context(run_id) else {
        return;
    };
    let prefs = store.notification_prefs().unwrap_or_default();
    if let Some(n) = notification_for(event, &project, agent.as_deref(), &prompt, prefs) {
        if let Err(e) = app
            .notification()
            .builder()
            .title(&n.title)
            .body(&n.body)
            .show()
        {
            warn!("notificação falhou: {e}");
        }
    }
}
