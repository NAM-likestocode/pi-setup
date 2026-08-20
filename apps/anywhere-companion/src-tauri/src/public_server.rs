use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{async_runtime, AppHandle};
use tokio::{net::TcpListener, time::timeout};
use uuid::Uuid;

use crate::{
    auth::{create_device_token, device_matches, pairing_matches, revoke_device},
    protocol::{valid_version, CommandFrame, MessageFrame, PromptAnswerFrame, PROTOCOL_VERSION},
    registry::RegistryState,
    state::{apply_session_aliases, persist, AppState},
};

#[derive(Clone)]
struct PublicServerState {
    app: AppHandle,
    runtime: AppState,
    registry: RegistryState,
    rate: Arc<Mutex<HashMap<String, RateBucket>>>,
    idempotency: Arc<Mutex<HashMap<String, (Instant, Value)>>>,
}

#[derive(Debug, Clone)]
struct RateBucket {
    started: Instant,
    count: u32,
}

const READ_RATE_LIMIT: u32 = 180;
const WRITE_RATE_LIMIT: u32 = 40;
const RATE_WINDOW: Duration = Duration::from_secs(60);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PairRequest {
    version: u8,
    token: String,
    #[serde(rename = "deviceName")]
    _device_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairResponse {
    version: u8,
    host_id: String,
    base_url: String,
    device_token: String,
    paired_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapResponse {
    version: u8,
    host_id: String,
    base_url: String,
    machine_name: Option<String>,
    paired: bool,
    companion_enabled: bool,
    instance_count: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MessageRequest {
    version: u8,
    idempotency_key: String,
    text: String,
    delivery: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PromptAnswerRequest {
    version: u8,
    answer: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PushTokenRequest {
    version: u8,
    token: String,
    platform: String,
}

#[derive(Debug, Deserialize)]
struct HistoryQuery {
    cursor: Option<String>,
    limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct StateQuery {
    since: Option<u64>,
}

pub async fn start(
    runtime: AppState,
    registry: RegistryState,
    app: AppHandle,
) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("Could not bind public companion server: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Could not read public companion port: {error}"))?
        .port();
    let state = PublicServerState {
        app,
        runtime,
        registry,
        rate: Arc::new(Mutex::new(HashMap::new())),
        idempotency: Arc::new(Mutex::new(HashMap::new())),
    };
    async_runtime::spawn(async move {
        let router = Router::new()
            .route("/api/v2/pair", post(pair))
            .route("/api/v2/bootstrap", get(bootstrap))
            .route("/api/v2/instances", get(instances))
            .route("/api/v2/instances/{instance_id}/history", get(history))
            .route("/api/v2/instances/{instance_id}/state", get(instance_state))
            .route("/api/v2/instances/{instance_id}/messages", post(message))
            .route(
                "/api/v2/instances/{instance_id}/prompts/{prompt_id}/answer",
                post(prompt_answer),
            )
            .route("/api/v2/device/push-token", put(push_token))
            .route("/api/v2/device", delete(revoke))
            .layer(axum::extract::DefaultBodyLimit::max(16 * 1024))
            .with_state(state);
        if let Err(error) = axum::serve(listener, router).await {
            eprintln!("Pimo public server stopped: {error}");
        }
    });
    Ok(port)
}

fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({ "version": PROTOCOL_VERSION, "error": { "code": code, "message": message } })),
    )
        .into_response()
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    let value = headers.get("authorization")?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") || token.is_empty() {
        return None;
    }
    Some(token.to_string())
}

fn take_rate_slot(
    rates: &mut HashMap<String, RateBucket>,
    digest: &str,
    write: bool,
    now: Instant,
) -> bool {
    let class = if write { "write" } else { "read" };
    let limit = if write {
        WRITE_RATE_LIMIT
    } else {
        READ_RATE_LIMIT
    };
    let bucket = rates
        .entry(format!("{digest}:{class}"))
        .or_insert(RateBucket {
            started: now,
            count: 0,
        });
    if now.duration_since(bucket.started) >= RATE_WINDOW {
        bucket.started = now;
        bucket.count = 0;
    }
    bucket.count += 1;
    bucket.count <= limit
}

fn authorized(
    state: &PublicServerState,
    headers: &HeaderMap,
    write: bool,
) -> Result<String, Response> {
    let token = bearer(headers).ok_or_else(|| {
        error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "This phone is not paired.",
        )
    })?;
    let digest = crate::auth::digest_token(&token);
    let runtime = state.runtime.0.lock().map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "state_error",
            "Companion state lock is poisoned",
        )
    })?;
    if !runtime.persisted.enabled {
        return Err(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "companion_disabled",
            "Pimo access is disabled on this computer.",
        ));
    }
    if !device_matches(&runtime, &token) {
        return Err(error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "This phone is not paired to this computer.",
        ));
    }
    drop(runtime);
    let mut rates = state.rate.lock().map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "state_error",
            "Rate limiter lock is poisoned",
        )
    })?;
    if !take_rate_slot(&mut rates, &digest, write, Instant::now()) {
        return Err(error(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "Too many requests; try again shortly.",
        ));
    }
    Ok(digest)
}

async fn pair(State(state): State<PublicServerState>, Json(body): Json<PairRequest>) -> Response {
    if !valid_version(body.version) || body.token.len() < 20 {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Pairing data is invalid.",
        );
    }
    let mut runtime = match state.runtime.0.lock() {
        Ok(runtime) => runtime,
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "state_error",
                "Companion state lock is poisoned",
            )
        }
    };
    if !pairing_matches(&runtime, &body.token) {
        return error(
            StatusCode::UNAUTHORIZED,
            "pairing_expired",
            "This pairing code is invalid, expired, or already used.",
        );
    }
    let Some(base_url) = runtime.public_base_url.clone() else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "companion_unavailable",
            "Tailscale private HTTPS is not ready.",
        );
    };
    let device_token = create_device_token(&mut runtime);
    let paired_at = runtime.persisted.paired_at.unwrap_or(0);
    if let Err(message) = persist(&state.app, &runtime.persisted) {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "state_error", &message);
    }
    let response = PairResponse {
        version: PROTOCOL_VERSION,
        host_id: runtime.persisted.machine_id.clone(),
        base_url,
        device_token,
        paired_at,
    };
    Json(response).into_response()
}

async fn bootstrap(State(state): State<PublicServerState>, headers: HeaderMap) -> Response {
    if let Err(response) = authorized(&state, &headers, false) {
        return response;
    }
    let runtime = match state.runtime.0.lock() {
        Ok(runtime) => runtime,
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "state_error",
                "Companion state lock is poisoned",
            )
        }
    };
    let count = state.registry.count().unwrap_or(0);
    Json(BootstrapResponse {
        version: PROTOCOL_VERSION,
        host_id: runtime.persisted.machine_id.clone(),
        base_url: runtime.public_base_url.clone().unwrap_or_default(),
        machine_name: std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .ok(),
        paired: runtime.persisted.device_digest.is_some(),
        companion_enabled: runtime.persisted.enabled,
        instance_count: count,
    })
    .into_response()
}

async fn instances(State(state): State<PublicServerState>, headers: HeaderMap) -> Response {
    if let Err(response) = authorized(&state, &headers, false) {
        return response;
    }
    if let Err(message) = state.registry.remove_stale() {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "state_error", &message);
    }
    match state.registry.list() {
        Ok(mut instances) => {
            let runtime = match state.runtime.0.lock() {
                Ok(runtime) => runtime,
                Err(_) => {
                    return error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "state_error",
                        "Companion state lock is poisoned",
                    )
                }
            };
            apply_session_aliases(&mut instances, &runtime.persisted.session_aliases);
            Json(json!({ "version": PROTOCOL_VERSION, "instances": instances })).into_response()
        }
        Err(message) => error(StatusCode::INTERNAL_SERVER_ERROR, "state_error", &message),
    }
}

async fn instance_state(
    State(state): State<PublicServerState>,
    headers: HeaderMap,
    Path(instance_id): Path<String>,
    Query(query): Query<StateQuery>,
) -> Response {
    if let Err(response) = authorized(&state, &headers, false) {
        return response;
    }
    if let Err(message) = state.registry.remove_stale() {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "state_error", &message);
    }
    match state.registry.state(&instance_id) {
        Ok(Some(value)) => {
            Json(json!({ "version": PROTOCOL_VERSION, "state": filter_state(value, query.since) }))
                .into_response()
        }
        Ok(None) => error(
            StatusCode::NOT_FOUND,
            "not_found",
            "That Pi instance is no longer connected.",
        ),
        Err(message) => error(StatusCode::INTERNAL_SERVER_ERROR, "state_error", &message),
    }
}

fn filter_state(mut state: Value, since: Option<u64>) -> Value {
    let Some(since) = since else {
        return state;
    };
    let cursor = state.get("cursor").and_then(Value::as_u64).unwrap_or(0);
    let oldest = state
        .get("oldestCursor")
        .and_then(Value::as_u64)
        .unwrap_or(cursor);
    let reset = state
        .get("resetRequired")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || (since.saturating_add(1) < oldest && oldest > 0);
    if let Some(events) = state.get_mut("events").and_then(Value::as_array_mut) {
        events.retain(|event| {
            event
                .get("cursor")
                .and_then(Value::as_u64)
                .map(|value| value > since)
                .unwrap_or(false)
        });
    }
    if let Some(object) = state.as_object_mut() {
        object.insert("resetRequired".to_string(), Value::Bool(reset));
    }
    let _ = cursor;
    state
}

async fn history(
    State(state): State<PublicServerState>,
    headers: HeaderMap,
    Path(instance_id): Path<String>,
    Query(query): Query<HistoryQuery>,
) -> Response {
    if let Err(response) = authorized(&state, &headers, false) {
        return response;
    }
    let request_id = Uuid::new_v4().to_string();
    let (_waiter, receiver) = match state.registry.register_scoped_waiter(request_id.clone()) {
        Ok(waiter) => waiter,
        Err(message) => return error(StatusCode::INTERNAL_SERVER_ERROR, "state_error", &message),
    };
    let sent = state.registry.send(
        &instance_id,
        &crate::protocol::ServerFrame::Command(CommandFrame {
            version: PROTOCOL_VERSION,
            request_id: request_id.clone(),
            instance_id: instance_id.clone(),
            command: "history".to_string(),
            enabled: None,
            cursor: query.cursor,
            limit: query.limit,
        }),
    );
    match sent {
        Ok(true) => {}
        Ok(false) => {
            return error(
                StatusCode::NOT_FOUND,
                "instance_unavailable",
                "That Pi instance is no longer connected.",
            )
        }
        Err(message) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "instance_unavailable",
                &message,
            )
        }
    }
    match timeout(Duration::from_secs(10), receiver).await {
        Ok(Ok(value)) => {
            if value.get("ok").and_then(Value::as_bool) != Some(true) {
                return error(
                    StatusCode::CONFLICT,
                    "conflict",
                    "Pi could not load this history page.",
                );
            }
            value
                .get("history")
                .cloned()
                .map(|history| Json(history).into_response())
                .unwrap_or_else(|| {
                    error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "state_error",
                        "Pi returned no history.",
                    )
                })
        }
        _ => error(
            StatusCode::GATEWAY_TIMEOUT,
            "instance_unavailable",
            "Pi did not respond in time.",
        ),
    }
}

async fn message(
    State(state): State<PublicServerState>,
    headers: HeaderMap,
    Path(instance_id): Path<String>,
    Json(body): Json<MessageRequest>,
) -> Response {
    if let Err(response) = authorized(&state, &headers, true) {
        return response;
    }
    if !valid_version(body.version)
        || body.idempotency_key.is_empty()
        || body.idempotency_key.len() > 300
        || body.text.trim().is_empty()
        || body.text.len() > 12_000
        || (body.delivery != "steer" && body.delivery != "followUp")
    {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Message data is invalid.",
        );
    }
    if let Ok(mut cache) = state.idempotency.lock() {
        let now = Instant::now();
        cache.retain(|_, (created, _)| now.duration_since(*created) < Duration::from_secs(300));
        if let Some((_, cached)) = cache.get(&body.idempotency_key) {
            return Json(cached.clone()).into_response();
        }
    }
    let request_id = body.idempotency_key.clone();
    let (_waiter, receiver) = match state.registry.register_scoped_waiter(request_id.clone()) {
        Ok(waiter) => waiter,
        Err(message) => return error(StatusCode::INTERNAL_SERVER_ERROR, "state_error", &message),
    };
    let sent = state.registry.send(
        &instance_id,
        &crate::protocol::ServerFrame::Message(MessageFrame {
            version: PROTOCOL_VERSION,
            instance_id: instance_id.clone(),
            request_id: request_id.clone(),
            text: body.text.trim().to_string(),
            delivery: body.delivery,
        }),
    );
    match sent {
        Ok(true) => {}
        Ok(false) => {
            return error(
                StatusCode::NOT_FOUND,
                "instance_unavailable",
                "That Pi instance is no longer connected.",
            )
        }
        Err(message) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "instance_unavailable",
                &message,
            )
        }
    }
    match timeout(Duration::from_secs(10), receiver).await {
        Ok(Ok(value)) if value.get("accepted").and_then(Value::as_bool) == Some(true) => {
            let response = json!({ "version": PROTOCOL_VERSION, "accepted": true, "queued": true, "idempotencyKey": request_id });
            if let Ok(mut cache) = state.idempotency.lock() {
                cache.insert(body.idempotency_key, (Instant::now(), response.clone()));
            }
            Json(response).into_response()
        }
        Ok(Ok(value)) => error(
            StatusCode::CONFLICT,
            "conflict",
            value
                .get("errorCode")
                .and_then(Value::as_str)
                .unwrap_or("Pi rejected the message."),
        ),
        _ => error(
            StatusCode::GATEWAY_TIMEOUT,
            "instance_unavailable",
            "Pi did not respond in time.",
        ),
    }
}

async fn prompt_answer(
    State(state): State<PublicServerState>,
    headers: HeaderMap,
    Path((instance_id, prompt_id)): Path<(String, String)>,
    Json(body): Json<PromptAnswerRequest>,
) -> Response {
    if let Err(response) = authorized(&state, &headers, true) {
        return response;
    }
    if !valid_version(body.version) {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Prompt answer data is invalid.",
        );
    }
    let request_id = Uuid::new_v4().to_string();
    let (_waiter, receiver) = match state.registry.register_scoped_waiter(request_id.clone()) {
        Ok(waiter) => waiter,
        Err(message) => return error(StatusCode::INTERNAL_SERVER_ERROR, "state_error", &message),
    };
    let sent = state.registry.send(
        &instance_id,
        &crate::protocol::ServerFrame::PromptAnswer(PromptAnswerFrame {
            version: PROTOCOL_VERSION,
            instance_id: instance_id.clone(),
            prompt_id: prompt_id.clone(),
            request_id: request_id.clone(),
            answer: Some(body.answer),
        }),
    );
    match sent {
        Ok(true) => {}
        Ok(false) => {
            return error(
                StatusCode::NOT_FOUND,
                "instance_unavailable",
                "That Pi instance is no longer connected.",
            )
        }
        Err(message) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "instance_unavailable",
                &message,
            )
        }
    }
    match timeout(Duration::from_secs(10), receiver).await {
        Ok(Ok(value)) if value.get("accepted").and_then(Value::as_bool) == Some(true) => {
            Json(json!({ "version": PROTOCOL_VERSION, "accepted": true, "promptId": prompt_id }))
                .into_response()
        }
        Ok(Ok(value)) => error(
            StatusCode::CONFLICT,
            value
                .get("errorCode")
                .and_then(Value::as_str)
                .unwrap_or("already_settled"),
            "That prompt is no longer pending.",
        ),
        _ => error(
            StatusCode::GATEWAY_TIMEOUT,
            "instance_unavailable",
            "Pi did not respond in time.",
        ),
    }
}

async fn push_token(
    State(state): State<PublicServerState>,
    headers: HeaderMap,
    Json(body): Json<PushTokenRequest>,
) -> Response {
    if let Err(response) = authorized(&state, &headers, true) {
        return response;
    }
    if !valid_version(body.version)
        || body.token.trim().is_empty()
        || body.token.len() > 500
        || (body.platform != "android" && body.platform != "ios")
    {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Push token data is invalid.",
        );
    }
    let mut runtime = match state.runtime.0.lock() {
        Ok(runtime) => runtime,
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "state_error",
                "Companion state lock is poisoned",
            )
        }
    };
    runtime.persisted.push_token = Some(body.token);
    if let Err(message) = persist(&state.app, &runtime.persisted) {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "state_error", &message);
    }
    Json(json!({ "version": PROTOCOL_VERSION, "accepted": true })).into_response()
}

async fn revoke(State(state): State<PublicServerState>, headers: HeaderMap) -> Response {
    if let Err(response) = authorized(&state, &headers, true) {
        return response;
    }
    let mut runtime = match state.runtime.0.lock() {
        Ok(runtime) => runtime,
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "state_error",
                "Companion state lock is poisoned",
            )
        }
    };
    revoke_device(&mut runtime);
    if let Err(message) = persist(&state.app, &runtime.persisted) {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "state_error", &message);
    }
    Json(json!({ "version": PROTOCOL_VERSION, "accepted": true })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frequent_state_polling_does_not_consume_the_write_budget() {
        let now = Instant::now();
        let mut rates = HashMap::new();

        for _ in 0..READ_RATE_LIMIT {
            assert!(take_rate_slot(&mut rates, "phone", false, now));
        }
        for _ in 0..WRITE_RATE_LIMIT {
            assert!(take_rate_slot(&mut rates, "phone", true, now));
        }
        assert!(!take_rate_slot(&mut rates, "phone", true, now));
    }

    #[test]
    fn each_rate_class_enforces_its_own_limit() {
        let now = Instant::now();
        let mut rates = HashMap::new();

        for _ in 0..WRITE_RATE_LIMIT {
            assert!(take_rate_slot(&mut rates, "phone", true, now));
        }
        assert!(!take_rate_slot(&mut rates, "phone", true, now));
        assert!(take_rate_slot(&mut rates, "phone", false, now));
        assert!(take_rate_slot(&mut rates, "other-phone", true, now));
    }
}
