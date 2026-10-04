pub mod device;
pub mod filesystem;
pub mod permissions;
pub mod process;
pub mod storage;
pub mod terminal;

use serde::Serialize;
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub process_id: String,
    pub command: String,
    pub status: String,
    pub exit_code: i32,
    pub started_at_ms: u128,
}

#[derive(Debug, Clone)]
pub struct ProcessRecord {
    pub info: ProcessInfo,
    pub result: ExecResult,
}

pub struct RuntimeState {
    pub root: PathBuf,
    pub permissions: Mutex<HashSet<String>>,
    pub processes: Mutex<Vec<ProcessRecord>>,
}

impl RuntimeState {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            permissions: Mutex::new(HashSet::new()),
            processes: Mutex::new(Vec::new()),
        }
    }
}

pub fn require_permission(state: &RuntimeState, permission: &str) -> Result<(), String> {
    let granted = state
        .permissions
        .lock()
        .map_err(|_| "Permission state is unavailable.".to_string())?;
    if granted.contains(permission) {
        Ok(())
    } else {
        Err(format!(
            "Permission denied: {permission}. Request it with webOS.permissions.request() first."
        ))
    }
}

/// Map an absolute virtual path into the app-owned data directory.
///
/// This is a conservative path check (absolute virtual namespace only, no parent
/// components, no symlinks, and a canonical boundary check). It is not an OS
/// process sandbox and cannot eliminate all filesystem TOCTOU races; the runtime
/// exposes no host-shell command that could bypass this mapping.
pub fn resolve_sandbox_path(root: &Path, logical_path: &str) -> Result<PathBuf, String> {
    if logical_path.len() > 2048 || !logical_path.starts_with('/') {
        return Err("Virtual paths must be absolute and no longer than 2048 bytes.".to_string());
    }
    let mut candidate = root.to_path_buf();
    for component in Path::new(logical_path).components() {
        match component {
            Component::RootDir => {}
            Component::Normal(value) => {
                let value = value
                    .to_str()
                    .ok_or_else(|| "Virtual path contains non-UTF-8 characters.".to_string())?;
                if value.is_empty()
                    || value == "."
                    || value == ".."
                    || value.contains('\\')
                    || value.contains(':')
                    || value.contains('\0')
                {
                    return Err("Invalid virtual path component.".to_string());
                }
                candidate.push(value);
                match std::fs::symlink_metadata(&candidate) {
                    Ok(metadata) if metadata.file_type().is_symlink() => {
                        return Err("Symbolic links are not allowed in the virtual filesystem.".to_string());
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(format!("Could not inspect virtual path: {error}")),
                }
            }
            Component::CurDir | Component::ParentDir | Component::Prefix(_) => {
                return Err("Path traversal and platform-specific paths are blocked.".to_string());
            }
        }
    }

    let canonical_root = std::fs::canonicalize(root)
        .map_err(|error| format!("Could not open the app filesystem sandbox: {error}"))?;
    let mut nearest = candidate.as_path();
    while !nearest.exists() {
        nearest = nearest
            .parent()
            .ok_or_else(|| "Could not resolve virtual path.".to_string())?;
    }
    let canonical_nearest = std::fs::canonicalize(nearest)
        .map_err(|error| format!("Could not resolve virtual path: {error}"))?;
    if !canonical_nearest.starts_with(&canonical_root) {
        return Err("Path traversal outside the app filesystem sandbox was blocked.".to_string());
    }
    if let Ok(metadata) = std::fs::symlink_metadata(&candidate) {
        if metadata.file_type().is_symlink() {
            return Err("Symbolic links are not allowed in the virtual filesystem.".to_string());
        }
    }
    Ok(candidate)
}

pub fn result(stdout: impl Into<String>, stderr: impl Into<String>, exit_code: i32) -> ExecResult {
    ExecResult {
        stdout: stdout.into(),
        stderr: stderr.into(),
        exit_code,
    }
}
