mod runtime;

use runtime::RuntimeState;
use std::fs;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let root_path = app.path().app_data_dir()?.join("webos");
            fs::create_dir_all(&root_path)?;
            if fs::symlink_metadata(&root_path)?.file_type().is_symlink() {
                return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "the app filesystem root cannot be a symbolic link").into());
            }
            let root = fs::canonicalize(root_path)?;
            for directory in [
                root.join("home/user/Documents"),
                root.join("home/user/Downloads"),
                root.join("home/user/Desktop"),
                root.join("tmp"),
                root.join("apps"),
                root.join("storage"),
            ] {
                fs::create_dir_all(directory)?;
            }
            app.manage(RuntimeState::new(root));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            runtime::device::runtime_info,
            runtime::filesystem::fs_read_file,
            runtime::filesystem::fs_write_file,
            runtime::filesystem::fs_readdir,
            runtime::filesystem::fs_mkdir,
            runtime::filesystem::fs_remove,
            runtime::filesystem::fs_stat,
            runtime::permissions::permissions_request,
            runtime::permissions::permissions_check,
            runtime::permissions::permissions_list,
            runtime::process::process_spawn,
            runtime::process::process_list,
            runtime::process::process_kill,
            runtime::process::process_write,
            runtime::process::process_resize,
            runtime::storage::storage_set_item,
            runtime::storage::storage_get_item,
            runtime::storage::storage_remove_item,
            runtime::terminal::terminal_exec,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start the Tauri v2 Web OS shell");
}
