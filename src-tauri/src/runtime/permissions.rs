use super::{require_permission, RuntimeState};
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const PERMISSIONS: [(&str, &str); 8] = [
    ("filesystem:read", "read text files and list folders inside the app's virtual filesystem"),
    ("filesystem:write", "create or change files inside the app's virtual filesystem"),
    ("filesystem:delete", "delete files inside the app's virtual filesystem"),
    ("terminal:exec", "run built-in sandbox commands (not a host shell)"),
    ("process:spawn", "start a short-lived built-in app task (not an OS process)"),
    ("network:fetch", "make an HTTPS request from the app"),
    ("storage:read", "read the app's private key-value storage"),
    ("storage:write", "write the app's private key-value storage"),
];

#[derive(Debug, Serialize)]
pub struct PermissionStatus {
    pub name: String,
    pub granted: bool,
}

fn description(permission: &str) -> Option<&'static str> {
    PERMISSIONS
        .iter()
        .find(|(name, _)| *name == permission)
        .map(|(_, description)| *description)
}

#[tauri::command]
pub async fn permissions_request(
    app: AppHandle,
    permission: String,
    state: State<'_, RuntimeState>,
) -> Result<bool, String> {
    let description = description(&permission)
        .ok_or_else(|| format!("Unsupported permission: {permission}"))?;
    if require_permission(&state, &permission).is_ok() {
        return Ok(true);
    }

    let title = "Web OS permission request".to_string();
    let message = format!(
        "Allow this app to {description}?\n\nAccess stays inside this app's managed sandbox. This does not grant unrestricted access to your device."
    );
    let allowed = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message(message)
            .title(title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Allow".to_string(),
                "Deny".to_string(),
            ))
            .blocking_show()
    })
    .await
    .map_err(|error| format!("Could not show the native permission prompt: {error}"))?;

    if allowed {
        state
            .permissions
            .lock()
            .map_err(|_| "Permission state is unavailable.".to_string())?
            .insert(permission);
    }
    Ok(allowed)
}

#[tauri::command]
pub fn permissions_check(permission: String, state: State<'_, RuntimeState>) -> bool {
    state
        .permissions
        .lock()
        .map(|granted| granted.contains(&permission))
        .unwrap_or(false)
}

#[tauri::command]
pub fn permissions_list(state: State<'_, RuntimeState>) -> Vec<PermissionStatus> {
    let granted = state.permissions.lock().map(|set| set.clone()).unwrap_or_default();
    PERMISSIONS
        .iter()
        .map(|(name, _)| PermissionStatus {
            name: (*name).to_string(),
            granted: granted.contains(*name),
        })
        .collect()
}
