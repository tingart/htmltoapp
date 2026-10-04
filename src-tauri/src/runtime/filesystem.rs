use super::{require_permission, resolve_sandbox_path, RuntimeState};
use serde::Serialize;
use std::path::Path;
use tauri::State;

const MAX_TEXT_FILE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStats {
    pub name: String,
    pub is_directory: bool,
    pub size: u64,
    pub modified_at_ms: Option<u128>,
}

pub(crate) fn read_file_unchecked(state: &RuntimeState, logical_path: &str) -> Result<String, String> {
    let path = resolve_sandbox_path(&state.root, logical_path)?;
    let metadata = std::fs::metadata(&path).map_err(|error| format!("Could not read {logical_path}: {error}"))?;
    if !metadata.is_file() {
        return Err("The virtual path is not a file.".to_string());
    }
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Err("Text file exceeds the 64 MB runtime limit.".to_string());
    }
    std::fs::read_to_string(&path).map_err(|error| format!("Could not read UTF-8 text from {logical_path}: {error}"))
}

pub(crate) fn write_file_unchecked(
    state: &RuntimeState,
    logical_path: &str,
    content: &str,
) -> Result<(), String> {
    if content.len() as u64 > MAX_TEXT_FILE_BYTES {
        return Err("Text file exceeds the 64 MB runtime limit.".to_string());
    }
    let path = resolve_sandbox_path(&state.root, logical_path)?;
    if path == state.root {
        return Err("The virtual filesystem root cannot be written as a file.".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "The virtual path has no parent directory.".to_string())?;
    if !parent.is_dir() {
        return Err("Parent directory does not exist. Create it with webOS.fs.mkdir() first.".to_string());
    }
    std::fs::write(&path, content.as_bytes()).map_err(|error| format!("Could not write {logical_path}: {error}"))
}

pub(crate) fn list_names_unchecked(state: &RuntimeState, logical_path: &str) -> Result<Vec<String>, String> {
    let path = resolve_sandbox_path(&state.root, logical_path)?;
    if !path.is_dir() {
        return Err("The virtual path is not a directory.".to_string());
    }
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&path).map_err(|error| format!("Could not list {logical_path}: {error}"))? {
        let entry = entry.map_err(|error| format!("Could not read a directory entry: {error}"))?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "A filename is not valid UTF-8.".to_string())?;
        entries.push(name);
    }
    entries.sort();
    Ok(entries)
}

pub(crate) fn mkdir_unchecked(
    state: &RuntimeState,
    logical_path: &str,
    recursive: bool,
) -> Result<(), String> {
    let path = resolve_sandbox_path(&state.root, logical_path)?;
    if path == state.root {
        return Ok(());
    }
    let result = if recursive {
        std::fs::create_dir_all(&path)
    } else {
        std::fs::create_dir(&path)
    };
    result.map_err(|error| format!("Could not create {logical_path}: {error}"))
}

pub(crate) fn remove_unchecked(
    state: &RuntimeState,
    logical_path: &str,
    recursive: bool,
) -> Result<(), String> {
    let path = resolve_sandbox_path(&state.root, logical_path)?;
    if path == state.root {
        return Err("The virtual filesystem root cannot be removed.".to_string());
    }
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|error| format!("Could not find {logical_path}: {error}"))?;
    if metadata.is_dir() {
        if recursive {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_dir(&path)
        }
    } else {
        std::fs::remove_file(&path)
    }
    .map_err(|error| format!("Could not remove {logical_path}: {error}"))
}

fn require_non_root(path: &Path, state: &RuntimeState) -> Result<(), String> {
    if path == state.root {
        Err("This operation is not allowed on the virtual filesystem root.".to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn fs_read_file(path: String, state: State<'_, RuntimeState>) -> Result<String, String> {
    require_permission(&state, "filesystem:read")?;
    read_file_unchecked(&state, &path)
}

#[tauri::command]
pub fn fs_write_file(path: String, content: String, state: State<'_, RuntimeState>) -> Result<(), String> {
    require_permission(&state, "filesystem:write")?;
    write_file_unchecked(&state, &path, &content)
}

#[tauri::command]
pub fn fs_readdir(path: String, state: State<'_, RuntimeState>) -> Result<Vec<String>, String> {
    require_permission(&state, "filesystem:read")?;
    list_names_unchecked(&state, &path)
}

#[tauri::command]
pub fn fs_mkdir(path: String, recursive: bool, state: State<'_, RuntimeState>) -> Result<(), String> {
    require_permission(&state, "filesystem:write")?;
    mkdir_unchecked(&state, &path, recursive)
}

#[tauri::command]
pub fn fs_remove(path: String, recursive: bool, state: State<'_, RuntimeState>) -> Result<(), String> {
    require_permission(&state, "filesystem:delete")?;
    let resolved = resolve_sandbox_path(&state.root, &path)?;
    require_non_root(&resolved, &state)?;
    remove_unchecked(&state, &path, recursive)
}

#[tauri::command]
pub fn fs_stat(path: String, state: State<'_, RuntimeState>) -> Result<FileStats, String> {
    require_permission(&state, "filesystem:read")?;
    let resolved = resolve_sandbox_path(&state.root, &path)?;
    let metadata = std::fs::metadata(&resolved).map_err(|error| format!("Could not inspect {path}: {error}"))?;
    let name = if resolved == state.root {
        "/".to_string()
    } else {
        resolved.file_name().and_then(|name| name.to_str()).unwrap_or("").to_string()
    };
    let modified_at_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis());
    Ok(FileStats {
        name,
        is_directory: metadata.is_dir(),
        size: metadata.len(),
        modified_at_ms,
    })
}
