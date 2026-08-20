use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, State};
use tokio::time::timeout;
use uuid::Uuid;

use crate::{
    auth::create_pairing_uri,
    protocol::{CommandFrame, ServerFrame, PROTOCOL_VERSION},
    registry::RegistryState,
    rendezvous,
    state::{
        apply_session_aliases, persist, validated_session_alias, AppState, RuntimeState,
        MAX_SESSION_ALIASES,
    },
    tailscale,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionStatus {
    pub machine_id: String,
    pub enabled: bool,
    pub public_port: u16,
    pub internal_port: u16,
    pub process_epoch: String,
    pub instance_count: usize,
    pub instances: Vec<Value>,
    pub pairing_uri: Option<String>,
}

pub(crate) fn ensure_public_access(runtime: &mut RuntimeState) -> Result<(), String> {
    let executable = tailscale::default_executable()?;
    let base_url = tailscale::discover_default_url(&executable)?;
    if !runtime.serve_owned {
        tailscale::ensure_available_default(&executable, runtime.persisted.owned_serve_port)?;
        tailscale::start_default(&executable, runtime.persisted.public_port)?;
        runtime.serve_owned = true;
        runtime.persisted.owned_serve_port = Some(runtime.persisted.public_port);
    }
    runtime.public_base_url = Some(base_url);
    runtime.persisted.enabled = true;
    Ok(())
}

fn status_from_state(
    state: &AppState,
    registry: &RegistryState,
) -> Result<CompanionStatus, String> {
    registry.remove_stale()?;
    let mut instances = registry.list()?;
    let runtime = state
        .0
        .lock()
        .map_err(|_| "Companion state lock is poisoned".to_string())?;
    apply_session_aliases(&mut instances, &runtime.persisted.session_aliases);
    Ok(CompanionStatus {
        machine_id: runtime.persisted.machine_id.clone(),
        enabled: runtime.persisted.enabled,
        public_port: runtime.persisted.public_port,
        internal_port: runtime.internal_port,
        process_epoch: runtime.process_epoch.clone(),
        instance_count: instances.len(),
        instances,
        pairing_uri: runtime.pairing_uri.clone(),
    })
}

fn update_session_alias(
    aliases: &mut std::collections::HashMap<String, String>,
    session_id: &str,
    name: &str,
) -> Result<(), String> {
    match validated_session_alias(name)? {
        Some(alias) => {
            if !aliases.contains_key(session_id) && aliases.len() >= MAX_SESSION_ALIASES {
                return Err(format!(
                    "Pimo can store up to {MAX_SESSION_ALIASES} session display names. Clear an old name before adding another."
                ));
            }
            aliases.insert(session_id.to_string(), alias);
        }
        None => {
            aliases.remove(session_id);
        }
    }
    Ok(())
}

async fn request_instance_disconnect(
    registry: &RegistryState,
    instance_id: &str,
) -> Result<(), String> {
    if instance_id.trim().is_empty() || instance_id.len() > 300 {
        return Err("The Pi session identifier is invalid.".to_string());
    }
    let request_id = Uuid::new_v4().to_string();
    let (_waiter, receiver) = registry.register_scoped_waiter(request_id.clone())?;
    let frame = ServerFrame::Command(CommandFrame {
        version: PROTOCOL_VERSION,
        request_id: request_id.clone(),
        instance_id: instance_id.to_string(),
        command: "detach".to_string(),
        enabled: None,
        cursor: None,
        limit: None,
    });
    match registry.send(instance_id, &frame) {
        Ok(true) => {}
        Ok(false) => {
            return Err("That Pi session is no longer connected.".to_string());
        }
        Err(message) => {
            return Err(message);
        }
    }

    let result = match timeout(Duration::from_secs(5), receiver).await {
        Ok(Ok(value)) => value,
        _ => {
            return Err("Pi did not confirm the disconnect in time.".to_string());
        }
    };
    if result.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(result
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Pi refused the disconnect request.")
            .to_string());
    }
    registry.remove(instance_id)?;
    Ok(())
}

#[tauri::command]
pub fn companion_status(
    state: State<'_, AppState>,
    registry: State<'_, RegistryState>,
) -> Result<CompanionStatus, String> {
    status_from_state(&state, &registry)
}

#[tauri::command]
pub async fn disconnect_instance(
    registry: State<'_, RegistryState>,
    instance_id: String,
) -> Result<(), String> {
    let registry = registry.inner().clone();
    request_instance_disconnect(&registry, &instance_id).await
}

#[tauri::command]
pub fn rename_instance(
    app: AppHandle,
    state: State<'_, AppState>,
    registry: State<'_, RegistryState>,
    instance_id: String,
    name: String,
) -> Result<CompanionStatus, String> {
    if instance_id.trim().is_empty() || instance_id.len() > 300 {
        return Err("The Pi session identifier is invalid.".to_string());
    }
    let instance = registry
        .instance(&instance_id)?
        .ok_or_else(|| "That Pi session is no longer connected.".to_string())?;
    let session_id = instance
        .get("sessionId")
        .and_then(Value::as_str)
        .or_else(|| instance.get("id").and_then(Value::as_str))
        .filter(|value| !value.is_empty() && value.len() <= 300)
        .ok_or_else(|| "That Pi session has no stable session identifier.".to_string())?
        .to_string();
    {
        let mut runtime = state
            .0
            .lock()
            .map_err(|_| "Companion state lock is poisoned".to_string())?;
        update_session_alias(&mut runtime.persisted.session_aliases, &session_id, &name)?;
        persist(&app, &runtime.persisted)?;
    }
    status_from_state(&state, &registry)
}

#[tauri::command]
pub fn show_pairing(
    app: AppHandle,
    state: State<'_, AppState>,
    registry: State<'_, RegistryState>,
) -> Result<CompanionStatus, String> {
    {
        let mut runtime = state
            .0
            .lock()
            .map_err(|_| "Companion state lock is poisoned".to_string())?;
        ensure_public_access(&mut runtime)?;
        create_pairing_uri(&mut runtime)?;
        persist(&app, &runtime.persisted)?;
        rendezvous::write(&app, &runtime)?;
    }
    status_from_state(&state, &registry)
}

#[tauri::command]
pub fn re_pair(
    app: AppHandle,
    state: State<'_, AppState>,
    registry: State<'_, RegistryState>,
) -> Result<CompanionStatus, String> {
    {
        let mut runtime = state
            .0
            .lock()
            .map_err(|_| "Companion state lock is poisoned".to_string())?;
        ensure_public_access(&mut runtime)?;
        runtime.persisted.device_digest = None;
        runtime.persisted.push_token = None;
        runtime.persisted.paired_at = None;
        runtime.pairing_uri = None;
        create_pairing_uri(&mut runtime)?;
        persist(&app, &runtime.persisted)?;
        rendezvous::write(&app, &runtime)?;
    }
    status_from_state(&state, &registry)
}

#[tauri::command]
pub fn set_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    registry: State<'_, RegistryState>,
    enabled: bool,
) -> Result<CompanionStatus, String> {
    {
        let mut runtime = state
            .0
            .lock()
            .map_err(|_| "Companion state lock is poisoned".to_string())?;
        if enabled {
            ensure_public_access(&mut runtime)?;
        } else {
            if runtime.serve_owned || runtime.persisted.owned_serve_port.is_some() {
                let executable = tailscale::default_executable()?;
                tailscale::stop_owned_default(&executable, runtime.persisted.owned_serve_port)?;
                runtime.serve_owned = false;
                runtime.persisted.owned_serve_port = None;
            }
            runtime.public_base_url = None;
            runtime.persisted.enabled = false;
        }
        persist(&app, &runtime.persisted)?;
        rendezvous::write(&app, &runtime)?;
    }
    status_from_state(&state, &registry)
}

#[tauri::command]
pub fn diagnostics(state: State<'_, AppState>) -> Result<String, String> {
    let runtime = state
        .0
        .lock()
        .map_err(|_| "Companion state lock is poisoned".to_string())?;
    Ok(format!(
        "Pimo Companion\nMachine: {}\nEnabled: {}\nPublic port: {}\nInternal port: {}\nInstances: {}\nProcess epoch: {}",
        runtime.persisted.machine_id,
        runtime.persisted.enabled,
        runtime.persisted.public_port,
        runtime.internal_port,
        runtime.instance_count,
        runtime.process_epoch,
    ))
}

#[tauri::command]
pub fn quit_companion(app: AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{request_instance_disconnect, update_session_alias, CompanionStatus};
    use crate::registry::RegistryState;
    use serde_json::{json, Value};
    use tokio::sync::mpsc::unbounded_channel;

    #[test]
    fn companion_status_uses_camel_case_wire_keys() {
        let status = CompanionStatus {
            machine_id: "machine".to_string(),
            enabled: true,
            public_port: 443,
            internal_port: 1234,
            process_epoch: "epoch".to_string(),
            instance_count: 1,
            instances: vec![json!({
                "id": "instance-1",
                "epoch": "instance-epoch",
                "sessionId": "session-1",
                "projectName": "project",
                "cwd": "C:\\project",
                "state": "idle",
                "pendingPromptCount": 0,
                "lastActivityAt": 1,
                "connectedAt": 1,
            })],
            pairing_uri: Some("pi-anywhere://pair".to_string()),
        };

        assert_eq!(
            serde_json::to_value(status).unwrap(),
            json!({
                "machineId": "machine",
                "enabled": true,
                "publicPort": 443,
                "internalPort": 1234,
                "processEpoch": "epoch",
                "instanceCount": 1,
                "instances": [{
                    "id": "instance-1",
                    "epoch": "instance-epoch",
                    "sessionId": "session-1",
                    "projectName": "project",
                    "cwd": "C:\\project",
                    "state": "idle",
                    "pendingPromptCount": 0,
                    "lastActivityAt": 1,
                    "connectedAt": 1,
                }],
                "pairingUri": "pi-anywhere://pair",
            })
        );
    }

    #[test]
    fn session_alias_can_be_updated_and_cleared() {
        let mut aliases = std::collections::HashMap::new();
        update_session_alias(&mut aliases, "session-1", "  Deep work  ").expect("set alias");
        assert_eq!(
            aliases.get("session-1").map(String::as_str),
            Some("Deep work")
        );

        update_session_alias(&mut aliases, "session-1", "   ").expect("clear alias");
        assert!(!aliases.contains_key("session-1"));
    }

    #[tokio::test]
    async fn disconnect_command_removes_only_the_anywhere_registration() {
        let registry = RegistryState::default();
        let (sender, mut receiver) = unbounded_channel();
        registry
            .register(
                "instance-1".to_string(),
                json!({ "id": "instance-1", "epoch": "epoch-1" }),
                json!({ "instanceId": "instance-1", "events": [] }),
                sender,
            )
            .expect("register instance");
        let responding_registry = registry.clone();
        let responder = tokio::spawn(async move {
            let payload = receiver.recv().await.expect("disconnect command");
            let frame: Value = serde_json::from_str(&payload).expect("decode command");
            assert_eq!(frame["type"], "command");
            assert_eq!(frame["command"], "detach");
            let request_id = frame["requestId"].as_str().expect("request id");
            responding_registry.resolve_waiter(
                request_id,
                json!({
                    "type": "command_result",
                    "version": 2,
                    "requestId": request_id,
                    "ok": true,
                    "message": "Session disconnected from Pimo. Pi is still running."
                }),
            );
        });

        request_instance_disconnect(&registry, "instance-1")
            .await
            .expect("disconnect instance");
        responder.await.expect("responder task");
        assert_eq!(registry.count().expect("count instances"), 0);
    }
}
