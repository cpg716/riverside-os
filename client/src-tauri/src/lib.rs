#[cfg(desktop)]
pub mod app_updates;
pub mod hardware;
pub mod llama_server;
pub mod rosie_voice;
pub mod unified_server;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(llama_server::LlamaSidecarState::default())
        .manage(rosie_voice::RosieSpeechState::default())
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
            hardware::check_printer_connection,
            llama_server::rosie_llama_start,
            llama_server::rosie_llama_stop,
            llama_server::rosie_llama_status,
            llama_server::rosie_llama_chat_completions,
            rosie_voice::rosie_local_runtime_status,
            rosie_voice::rosie_transcribe_wav,
            rosie_voice::rosie_tts_speak,
            rosie_voice::rosie_tts_stop,
            rosie_voice::rosie_tts_status,
            #[cfg(desktop)]
            app_updates::check_app_update,
            #[cfg(desktop)]
            app_updates::install_app_update,
            unified_server::start_unified_server,
            unified_server::get_unified_server_status,
            unified_server::get_unified_host_network_identity,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
