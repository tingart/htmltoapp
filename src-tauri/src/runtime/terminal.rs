use super::filesystem::{list_names_unchecked, mkdir_unchecked, read_file_unchecked, remove_unchecked, write_file_unchecked};
use super::{require_permission, resolve_sandbox_path, result, ExecResult, RuntimeState};
use tauri::State;

const HELP: &str = "webOS sandbox terminal\n\nBuilt-ins: help, pwd, ls [path], cat <path>, echo <text>, mkdir <path>, touch <path>, rm <path>, clear\nCommands run as app-owned virtual filesystem operations. No host shell is started.";

fn user_path(path: Option<&String>) -> String {
    match path {
        Some(path) if path.starts_with('/') => path.clone(),
        Some(path) if !path.is_empty() => format!("/home/user/{path}"),
        _ => "/home/user".to_string(),
    }
}

fn usage(message: &str) -> ExecResult {
    result("", message, 2)
}

pub(crate) fn run_builtin(
    state: &RuntimeState,
    command: &str,
    args: &[String],
) -> Result<ExecResult, String> {
    match command {
        "help" => Ok(result(HELP, "", 0)),
        "pwd" => Ok(result("/home/user", "", 0)),
        "echo" => Ok(result(args.join(" "), "", 0)),
        "clear" => Ok(result("\x1b[2J\x1b[H", "", 0)),
        "ls" => {
            require_permission(state, "filesystem:read")?;
            if args.len() > 1 {
                return Ok(usage("Usage: ls [path]"));
            }
            let path = user_path(args.first());
            let entries = list_names_unchecked(state, &path)?;
            Ok(result(entries.join("\n"), "", 0))
        }
        "cat" => {
            require_permission(state, "filesystem:read")?;
            if args.len() != 1 {
                return Ok(usage("Usage: cat <path>"));
            }
            let path = user_path(args.first());
            match read_file_unchecked(state, &path) {
                Ok(content) => Ok(result(content, "", 0)),
                Err(error) => Ok(result("", error, 1)),
            }
        }
        "mkdir" => {
            require_permission(state, "filesystem:write")?;
            if args.len() != 1 {
                return Ok(usage("Usage: mkdir <path>"));
            }
            let path = user_path(args.first());
            match mkdir_unchecked(state, &path, false) {
                Ok(()) => Ok(result("", "", 0)),
                Err(error) => Ok(result("", error, 1)),
            }
        }
        "touch" => {
            require_permission(state, "filesystem:write")?;
            if args.len() != 1 {
                return Ok(usage("Usage: touch <path>"));
            }
            let path = user_path(args.first());
            match resolve_sandbox_path(&state.root, &path) {
                Ok(resolved) if resolved.is_file() => Ok(result("", "", 0)),
                Ok(resolved) if resolved.exists() => Ok(result("", "Path is not a regular file.", 1)),
                Ok(_) => match write_file_unchecked(state, &path, "") {
                    Ok(()) => Ok(result("", "", 0)),
                    Err(error) => Ok(result("", error, 1)),
                },
                Err(error) => Ok(result("", error, 1)),
            }
        }
        "rm" => {
            require_permission(state, "filesystem:delete")?;
            if args.len() != 1 {
                return Ok(usage("Usage: rm <path>"));
            }
            let path = user_path(args.first());
            match remove_unchecked(state, &path, false) {
                Ok(()) => Ok(result("", "", 0)),
                Err(error) => Ok(result("", error, 1)),
            }
        }
        _ => Ok(result(
            "",
            format!("Command not available: {command}. Run 'help' for the sandbox built-ins."),
            127,
        )),
    }
}

#[tauri::command]
pub fn terminal_exec(command: String, state: State<'_, RuntimeState>) -> Result<ExecResult, String> {
    require_permission(&state, "terminal:exec")?;
    if command.len() > 16 * 1024 {
        return Err("Terminal input exceeds the 16 KB limit.".to_string());
    }
    let mut parts = command.split_whitespace();
    let Some(verb) = parts.next() else {
        return Ok(result("", "", 0));
    };
    let args = parts.map(str::to_string).collect::<Vec<_>>();
    if args.len() > 128 || args.iter().any(|argument| argument.len() > 4096) {
        return Err("Terminal input contains too many or oversized arguments.".to_string());
    }
    run_builtin(&state, verb, &args)
}
