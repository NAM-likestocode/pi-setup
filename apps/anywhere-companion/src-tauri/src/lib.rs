#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth;
mod commands;
mod internal_server;
mod protocol;
mod public_server;
mod push;
mod registry;
mod rendezvous;
mod state;
mod tailscale;
mod tray;

use tauri::{Manager, RunEvent, WindowEvent};

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            tray::show_window(app);
        }))
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::companion_status,
            commands::disconnect_instance,
            commands::rename_instance,
            commands::show_pairing,
            commands::re_pair,
            commands::set_enabled,
            commands::diagnostics,
            commands::quit_companion,
        ])
        .setup(|app| {
            let persisted = state::load(&app.handle()).map_err(std::io::Error::other)?;
            let app_state = state::AppState::new(persisted);
            let registry = registry::RegistryState::default();
            app.manage(app_state.clone());
            app.manage(registry.clone());

            let internal_port = tauri::async_runtime::block_on(internal_server::start(
                app.handle().clone(),
                app_state.clone(),
                registry.clone(),
            ))
            .map_err(std::io::Error::other)?;
            let public_port = tauri::async_runtime::block_on(public_server::start(
                app_state.clone(),
                registry,
                app.handle().clone(),
            ))
            .map_err(std::io::Error::other)?;
            {
                let mut runtime = app_state
                    .0
                    .lock()
                    .map_err(|_| std::io::Error::other("Companion state lock is poisoned"))?;
                runtime.internal_port = internal_port;
                let previously_owned_port = runtime.persisted.owned_serve_port;
                runtime.persisted.public_port = public_port;
                if let Ok(executable) = tailscale::default_executable() {
                    if let Ok(base_url) = tailscale::discover_default_url(&executable) {
                        runtime.public_base_url = Some(base_url);
                        if runtime.persisted.enabled {
                            match tailscale::ensure_available_default(
                                &executable,
                                previously_owned_port,
                            )
                            .and_then(|()| tailscale::start_default(&executable, public_port))
                            {
                                Ok(()) => {
                                    runtime.serve_owned = true;
                                    runtime.persisted.owned_serve_port = Some(public_port);
                                }
                                Err(error) => {
                                    eprintln!("Pimo Tailscale Serve is unavailable: {error}")
                                }
                            }
                        }
                    }
                }
                state::persist(&app.handle(), &runtime.persisted).map_err(std::io::Error::other)?;
                rendezvous::write(&app.handle(), &runtime).map_err(std::io::Error::other)?;
            }
            tray::install(&app.handle()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building Pimo Companion");
    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            let _ = rendezvous::remove(app_handle);
        }
    });
}
