#[cfg(desktop)]
pub mod app_updates;
pub mod hardware;
pub mod llama_server;
pub mod unified_server;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(llama_server::LlamaSidecarState::default())
        .manage(unified_server::UnifiedServerState::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            hardware::print_zpl_receipt,
            hardware::print_escpos_receipt,
            hardware::print_escpos_binary_b64,
            llama_server::rosie_llama_start,
            llama_server::rosie_llama_stop,
            llama_server::rosie_llama_status,
            #[cfg(desktop)]
            app_updates::check_app_update,
            #[cfg(desktop)]
            app_updates::install_app_update,
            unified_server::start_unified_server,
            unified_server::get_unified_server_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
