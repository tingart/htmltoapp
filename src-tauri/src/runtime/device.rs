use serde::Serialize;
use tauri::AppHandle;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub is_native: bool,
    pub platform: &'static str,
    pub os: &'static str,
    pub architecture: &'static str,
    pub app_name: String,
    pub app_version: String,
}

#[cfg(target_os = "android")]
const PLATFORM: &str = "android";
#[cfg(target_os = "windows")]
const PLATFORM: &str = "windows";
#[cfg(target_os = "macos")]
const PLATFORM: &str = "macos";
#[cfg(target_os = "linux")]
const PLATFORM: &str = "linux";
#[cfg(not(any(target_os = "android", target_os = "windows", target_os = "macos", target_os = "linux")))]
const PLATFORM: &str = "unknown";

#[tauri::command]
pub fn runtime_info(app: AppHandle) -> RuntimeInfo {
    RuntimeInfo {
        is_native: true,
        platform: PLATFORM,
        os: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        app_name: app.package_info().name.clone(),
        app_version: app.package_info().version.to_string(),
    }
}
