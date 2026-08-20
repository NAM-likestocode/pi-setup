use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

pub const STATE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedState {
    pub schema_version: u32,
    pub machine_id: String,
    pub public_port: u16,
    #[serde(default)]
    pub owned_serve_port: Option<u16>,
    pub enabled: bool,
    pub pairing_digest: Option<String>,
    #[serde(default)]
    pub device_digest: Option<String>,
    pub push_token: Option<String>,
    pub paired_at: Option<i64>,
    #[serde(default)]
    pub session_aliases: HashMap<String, String>,
}

impl Default for PersistedState {
    fn default() -> Self {
        Self {
            schema_version: STATE_SCHEMA_VERSION,
            machine_id: Uuid::new_v4().to_string(),
            public_port: 0,
            owned_serve_port: None,
            enabled: true,
            pairing_digest: None,
            device_digest: None,
            push_token: None,
            paired_at: None,
            session_aliases: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct RuntimeState {
    pub persisted: PersistedState,
    pub process_epoch: String,
    pub registration_token: String,
    pub internal_port: u16,
    pub pairing_uri: Option<String>,
    pub pairing_expires_at: Option<i64>,
    pub public_base_url: Option<String>,
    pub serve_owned: bool,
    pub instance_count: usize,
    pub notified_prompts: HashSet<String>,
}

#[derive(Clone)]
pub struct AppState(pub Arc<Mutex<RuntimeState>>);

impl AppState {
    pub fn new(persisted: PersistedState) -> Self {
        Self(Arc::new(Mutex::new(RuntimeState {
            persisted,
            process_epoch: Uuid::new_v4().to_string(),
            registration_token: random_token(),
            internal_port: 0,
            pairing_uri: None,
            pairing_expires_at: None,
            public_base_url: None,
            serve_owned: false,
            instance_count: 0,
            notified_prompts: HashSet::new(),
        })))
    }
}

pub fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve companion data directory: {error}"))
}

pub fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("state.json"))
}

pub fn rendezvous_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("rendezvous.json"))
}

pub fn load(app: &AppHandle) -> Result<PersistedState, String> {
    let path = state_path(app)?;
    if !path.exists() {
        return Ok(PersistedState::default());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("Could not read companion state: {error}"))?;
    let state: PersistedState = serde_json::from_str(&raw)
        .map_err(|error| format!("Companion state is invalid: {error}"))?;
    if state.schema_version > STATE_SCHEMA_VERSION {
        return Err(format!(
            "Companion state schema {} is newer than this build",
            state.schema_version
        ));
    }
    Ok(state)
}

pub fn persist(app: &AppHandle, state: &PersistedState) -> Result<(), String> {
    let path = state_path(app)?;
    write_secure_json(&path, state)
}

pub fn write_secure_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "State path has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create companion data directory: {error}"))?;
    let temporary = path.with_extension("json.next");
    let content = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Could not serialize companion state: {error}"))?;
    fs::write(&temporary, content)
        .map_err(|error| format!("Could not write companion state: {error}"))?;
    set_private_permissions(&temporary)?;
    if let Err(error) = fs::rename(&temporary, path) {
        #[cfg(windows)]
        {
            let _ = error;
            fs::remove_file(path).map_err(|remove_error| {
                format!("Could not replace companion state: {remove_error}")
            })?;
            fs::rename(&temporary, path).map_err(|rename_error| {
                format!("Could not replace companion state: {rename_error}")
            })?;
        }
        #[cfg(not(windows))]
        {
            return Err(format!(
                "Could not atomically replace companion state: {error}"
            ));
        }
    }
    set_private_permissions(path)
}

fn set_private_permissions(_path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(_path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Could not restrict companion state permissions: {error}"))?;
    }
    Ok(())
}

pub const MAX_SESSION_ALIASES: usize = 256;
pub const MAX_SESSION_ALIAS_CHARS: usize = 80;

pub fn validated_session_alias(value: &str) -> Result<Option<String>, String> {
    let alias = value.trim();
    if alias.is_empty() {
        return Ok(None);
    }
    if alias.chars().count() > MAX_SESSION_ALIAS_CHARS
        || alias.chars().any(|character| character.is_control())
    {
        return Err(format!(
            "Session names must be {MAX_SESSION_ALIAS_CHARS} characters or fewer and cannot contain control characters."
        ));
    }
    Ok(Some(alias.to_string()))
}

pub fn apply_session_aliases(
    instances: &mut [serde_json::Value],
    aliases: &HashMap<String, String>,
) {
    for instance in instances {
        let session_id = instance
            .get("sessionId")
            .and_then(serde_json::Value::as_str)
            .or_else(|| instance.get("id").and_then(serde_json::Value::as_str));
        let Some(alias) = session_id.and_then(|session_id| aliases.get(session_id)) else {
            continue;
        };
        let Ok(Some(alias)) = validated_session_alias(alias) else {
            continue;
        };
        if let Some(object) = instance.as_object_mut() {
            object.insert("sessionName".to_string(), serde_json::Value::String(alias));
        }
    }
}

pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn old_state_files_default_to_no_session_aliases() {
        let state: PersistedState = serde_json::from_value(json!({
            "schema_version": 1,
            "machine_id": "machine",
            "public_port": 1234,
            "enabled": true,
            "pairing_digest": null,
            "device_digest": null,
            "push_token": null,
            "paired_at": null
        }))
        .expect("deserialize old state");

        assert!(state.session_aliases.is_empty());
        assert_eq!(state.owned_serve_port, None);
    }

    #[test]
    fn session_aliases_override_only_the_matching_display_name() {
        let mut instances = vec![
            json!({
                "id": "instance-1",
                "sessionId": "session-1",
                "sessionName": "Pi name"
            }),
            json!({
                "id": "instance-2",
                "sessionId": "session-2",
                "sessionName": "Other Pi name"
            }),
        ];
        let aliases = HashMap::from([("session-1".to_string(), "My display name".to_string())]);

        apply_session_aliases(&mut instances, &aliases);

        assert_eq!(instances[0]["sessionName"], "My display name");
        assert_eq!(instances[1]["sessionName"], "Other Pi name");
    }

    #[test]
    fn session_alias_validation_allows_clear_but_rejects_controls() {
        assert_eq!(
            validated_session_alias("  Focus  ").unwrap(),
            Some("Focus".to_string())
        );
        assert_eq!(validated_session_alias("   ").unwrap(), None);
        assert!(validated_session_alias("line\nbreak").is_err());
    }
}
