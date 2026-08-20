use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
use subtle::ConstantTimeEq;

use crate::state::{random_token, RuntimeState};

pub const PAIRING_TTL_MS: i64 = 10 * 60 * 1_000;

pub fn digest_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    hex::encode(digest)
}

pub fn token_matches_digest(token: &str, expected: Option<&str>) -> bool {
    let Some(expected) = expected else {
        return false;
    };
    digest_token(token)
        .as_bytes()
        .ct_eq(expected.as_bytes())
        .into()
}

pub fn tokens_equal(left: &str, right: &str) -> bool {
    left.as_bytes().ct_eq(right.as_bytes()).into()
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

pub fn create_pairing_uri(runtime: &mut RuntimeState) -> Result<String, String> {
    let base_url = runtime.public_base_url.clone().ok_or_else(|| {
        "Tailscale is not connected; no private HTTPS URL is available.".to_string()
    })?;
    let token = random_token();
    let expires = now_ms() + PAIRING_TTL_MS;
    runtime.persisted.pairing_digest = Some(digest_token(&token));
    runtime.pairing_expires_at = Some(expires);
    let machine_name = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "Pi computer".to_string());
    let uri = format!(
        "pi-anywhere://pair?v=2&host={}&base={}&name={}#{}",
        urlencoding::encode(&runtime.persisted.machine_id),
        urlencoding::encode(&base_url),
        urlencoding::encode(&machine_name),
        token,
    );
    runtime.pairing_uri = Some(uri.clone());
    Ok(uri)
}

pub fn pairing_matches(runtime: &RuntimeState, token: &str) -> bool {
    runtime
        .pairing_expires_at
        .map(|expires| expires > now_ms())
        .unwrap_or(false)
        && token_matches_digest(token, runtime.persisted.pairing_digest.as_deref())
}

pub fn create_device_token(runtime: &mut RuntimeState) -> String {
    let token = random_token();
    runtime.persisted.device_digest = Some(digest_token(&token));
    runtime.persisted.pairing_digest = None;
    runtime.pairing_expires_at = None;
    runtime.pairing_uri = None;
    runtime.persisted.paired_at = Some(now_ms());
    token
}

pub fn device_matches(runtime: &RuntimeState, token: &str) -> bool {
    token_matches_digest(token, runtime.persisted.device_digest.as_deref())
}

pub fn revoke_device(runtime: &mut RuntimeState) {
    runtime.persisted.device_digest = None;
    runtime.persisted.pairing_digest = None;
    runtime.persisted.push_token = None;
    runtime.persisted.paired_at = None;
    runtime.pairing_expires_at = None;
    runtime.pairing_uri = None;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::PersistedState;

    fn runtime() -> RuntimeState {
        RuntimeState {
            persisted: PersistedState::default(),
            process_epoch: "epoch".to_string(),
            registration_token: "registration".to_string(),
            internal_port: 1,
            pairing_uri: None,
            pairing_expires_at: None,
            public_base_url: Some("https://desktop.example.ts.net".to_string()),
            serve_owned: false,
            instance_count: 0,
            notified_prompts: std::collections::HashSet::new(),
        }
    }

    #[test]
    fn pairing_token_is_one_time_and_device_survives_pairing() {
        let mut state = runtime();
        let uri = create_pairing_uri(&mut state).expect("pairing uri");
        let token = uri.split('#').nth(1).expect("fragment");
        assert!(pairing_matches(&state, token));
        let device = create_device_token(&mut state);
        assert!(device_matches(&state, &device));
        assert!(!pairing_matches(&state, token));
    }

    #[test]
    fn token_comparison_is_not_plain_string_prefix_matching() {
        assert!(tokens_equal("token", "token"));
        assert!(!tokens_equal("token", "token-extra"));
        assert!(token_matches_digest("token", Some(&digest_token("token"))));
    }
}
