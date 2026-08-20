use serde::{Deserialize, Serialize};
use std::fs;
use tauri::AppHandle;

use crate::state::{rendezvous_path, write_secure_json, RuntimeState};

pub const RENDEZVOUS_SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rendezvous {
    pub version: u32,
    pub process_epoch: String,
    pub internal_port: u16,
    pub registration_token: String,
}

pub fn write(app: &AppHandle, runtime: &RuntimeState) -> Result<(), String> {
    let rendezvous = Rendezvous {
        version: RENDEZVOUS_SCHEMA_VERSION,
        process_epoch: runtime.process_epoch.clone(),
        internal_port: runtime.internal_port,
        registration_token: runtime.registration_token.clone(),
    };
    write_secure_json(&rendezvous_path(app)?, &rendezvous)
}

pub fn remove(app: &AppHandle) -> Result<(), String> {
    let path = rendezvous_path(app)?;
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("Could not remove companion rendezvous file: {error}"))?;
    }
    Ok(())
}
