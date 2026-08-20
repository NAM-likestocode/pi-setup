use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

pub fn install(app: &AppHandle) -> Result<(), String> {
    let show = MenuItem::with_id(app, "show", "Open Pimo", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let pairing = MenuItem::with_id(app, "pairing", "Show pairing QR", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let status = MenuItem::with_id(app, "status", "Refresh status", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let separator = PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?;
    let quit = MenuItem::with_id(app, "quit", "Quit Pimo", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let menu = Menu::with_items(app, &[&show, &pairing, &status, &separator, &quit])
        .map_err(|error| error.to_string())?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "Pimo app icon is unavailable".to_string())?;

    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Pimo Companion")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" | "pairing" | "status" => show_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(event, TrayIconEvent::DoubleClick { .. }) {
                show_window(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|error| format!("Could not create tray icon: {error}"))?;
    Ok(())
}

pub fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
