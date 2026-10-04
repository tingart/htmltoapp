use super::{require_permission, resolve_sandbox_path, RuntimeState};
use tauri::State;

const MAX_VALUE_BYTES: usize = 4 * 1024 * 1024;

fn validate_key(key: &str) -> Result<String, String> {
    if key.is_empty() || key.len() > 180 || key.chars().any(|character| character.is_control() || character == '/' || character == '\\') {
        return Err("Storage keys must be 1–180 bytes and cannot contain slashes or control characters.".to_string());
    }
    let mut encoded = String::with_capacity(key.len() * 2);
    for byte in key.as_bytes() {
        use std::fmt::Write;
        write!(&mut encoded, "{byte:02x}").map_err(|_| "Could not encode storage key.".to_string())?;
    }
    Ok(encoded)
}

#[tauri::command]
pub fn storage_set_item(key: String, value: String, state: State<'_, RuntimeState>) -> Result<(), String> {
    require_permission(&state, "storage:write")?;
    if value.len() > MAX_VALUE_BYTES {
        return Err("A storage value exceeds the 4 MB limit.".to_string());
    }
    let key = validate_key(&key)?;
    let logical = format!("/storage/{key}");
    let path = resolve_sandbox_path(&state.root, &logical)?;
    std::fs::write(path, value.as_bytes()).map_err(|error| format!("Could not store value: {error}"))
}

#[tauri::command]
pub fn storage_get_item(key: String, state: State<'_, RuntimeState>) -> Result<Option<String>, String> {
    require_permission(&state, "storage:read")?;
    let key = validate_key(&key)?;
    let logical = format!("/storage/{key}");
    let path = resolve_sandbox_path(&state.root, &logical)?;
    match std::fs::read_to_string(path) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read stored value: {error}")),
    }
}

#[tauri::command]
pub fn storage_remove_item(key: String, state: State<'_, RuntimeState>) -> Result<bool, String> {
    require_permission(&state, "storage:write")?;
    let key = validate_key(&key)?;
    let logical = format!("/storage/{key}");
    let path = resolve_sandbox_path(&state.root, &logical)?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Could not remove stored value: {error}")),
    }
}
