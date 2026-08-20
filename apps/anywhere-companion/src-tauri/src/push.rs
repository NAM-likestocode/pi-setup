use serde_json::json;
use tauri::async_runtime;

use crate::state::{persist, AppState};

pub fn notify_pending_prompt(app: tauri::AppHandle, runtime: AppState, prompt_id: &str) {
    let token = {
        let Ok(mut state) = runtime.0.lock() else {
            return;
        };
        let Some(token) = state.persisted.push_token.clone() else {
            return;
        };
        if !state.notified_prompts.insert(prompt_id.to_string()) {
            return;
        }
        token
    };
    async_runtime::spawn(async move {
        let payload = json!({
            "to": token,
            "title": "Pi needs your answer",
            "body": "Pi needs your answer",
            "data": { "kind": "pending_prompt" },
            "sound": "default",
        });
        let response = reqwest::Client::new()
            .post("https://exp.host/--/api/v2/push/send")
            .json(&payload)
            .send()
            .await;
        match response {
            Ok(response) if response.status().is_success() => {}
            Ok(response) if response.status().is_client_error() => {
                if let Ok(mut state) = runtime.0.lock() {
                    state.persisted.push_token = None;
                    let _ = persist(&app, &state.persisted);
                }
            }
            Ok(response) => eprintln!("Expo Push returned {}", response.status()),
            Err(error) => eprintln!("Expo Push request failed: {error}"),
        }
    });
}
