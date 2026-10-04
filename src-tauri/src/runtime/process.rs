use super::{require_permission, ProcessInfo, ProcessRecord, RuntimeState};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

static NEXT_PROCESS_ID: AtomicU64 = AtomicU64::new(1);
const MAX_RECORDED_TASKS: usize = 64;

#[tauri::command]
pub fn process_spawn(
    command: String,
    args: Vec<String>,
    state: State<'_, RuntimeState>,
) -> Result<String, String> {
    require_permission(&state, "process:spawn")?;
    require_permission(&state, "terminal:exec")?;
    if command.is_empty() || command.len() > 64 || args.len() > 128 {
        return Err("Invalid sandbox task command or argument count.".to_string());
    }
    if args.iter().any(|arg| arg.len() > 4096) {
        return Err("A task argument is too long.".to_string());
    }

    let result = super::terminal::run_builtin(&state, &command, &args)?;
    let process_id = format!("webos-{}", NEXT_PROCESS_ID.fetch_add(1, Ordering::Relaxed));
    let started_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let info = ProcessInfo {
        process_id: process_id.clone(),
        command: std::iter::once(command).chain(args).collect::<Vec<_>>().join(" "),
        status: "exited".to_string(),
        exit_code: result.exit_code,
        started_at_ms,
    };
    let mut processes = state
        .processes
        .lock()
        .map_err(|_| "Process state is unavailable.".to_string())?;
    processes.push(ProcessRecord { info, result });
    let excess = processes.len().saturating_sub(MAX_RECORDED_TASKS);
    if excess > 0 {
        processes.drain(0..excess);
    }
    Ok(process_id)
}

#[tauri::command]
pub fn process_list(state: State<'_, RuntimeState>) -> Result<Vec<ProcessInfo>, String> {
    require_permission(&state, "process:spawn")?;
    let processes = state
        .processes
        .lock()
        .map_err(|_| "Process state is unavailable.".to_string())?;
    Ok(processes.iter().map(|record| record.info.clone()).collect())
}

#[tauri::command]
pub fn process_kill(process_id: String, state: State<'_, RuntimeState>) -> Result<bool, String> {
    require_permission(&state, "process:spawn")?;
    let mut processes = state
        .processes
        .lock()
        .map_err(|_| "Process state is unavailable.".to_string())?;
    let old_len = processes.len();
    processes.retain(|record| record.info.process_id != process_id);
    Ok(processes.len() != old_len)
}

/// Interactive sessions are intentionally not implemented in the starter runtime.
/// These commands provide explicit, safe failures instead of silently pretending to
/// control a host shell or a long-lived native process.
#[tauri::command]
pub fn process_write(
    process_id: String,
    data: String,
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    let _ = data;
    require_permission(&state, "process:spawn")?;
    let exists = state
        .processes
        .lock()
        .map_err(|_| "Process state is unavailable.".to_string())?
        .iter()
        .any(|record| record.info.process_id == process_id);
    if exists {
        Err("This starter runtime runs short-lived built-in tasks only; interactive stdin is not available.".to_string())
    } else {
        Err("Unknown app task ID.".to_string())
    }
}

#[tauri::command]
pub fn process_resize(
    process_id: String,
    columns: u16,
    rows: u16,
    state: State<'_, RuntimeState>,
) -> Result<bool, String> {
    let _ = (process_id, columns, rows);
    require_permission(&state, "process:spawn")?;
    Ok(false)
}
