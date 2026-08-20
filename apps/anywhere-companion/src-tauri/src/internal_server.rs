use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tauri::{async_runtime, AppHandle};
use tokio::{
    net::TcpListener,
    sync::mpsc::unbounded_channel,
    time::{sleep, Duration},
};

use crate::{
    auth::{create_pairing_uri, revoke_device, tokens_equal},
    commands::ensure_public_access,
    protocol::{valid_version, ClientFrame, CommandResultFrame, PROTOCOL_VERSION},
    push,
    registry::RegistryState,
    rendezvous,
    state::{persist, AppState},
    tailscale,
};

#[derive(Clone)]
pub struct InternalServerState {
    pub app: AppHandle,
    pub runtime: AppState,
    pub registry: RegistryState,
}

pub async fn start(
    app: AppHandle,
    runtime: AppState,
    registry: RegistryState,
) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("Could not bind internal companion server: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Could not read internal companion port: {error}"))?
        .port();
    let state = InternalServerState {
        app,
        runtime,
        registry: registry.clone(),
    };
    async_runtime::spawn(async move {
        let router = Router::new()
            .route("/internal", get(upgrade))
            .with_state(state);
        if let Err(error) = axum::serve(listener, router).await {
            eprintln!("Pimo internal server stopped: {error}");
        }
    });
    async_runtime::spawn(async move {
        loop {
            sleep(Duration::from_secs(10)).await;
            let _ = registry.remove_stale();
        }
    });
    Ok(port)
}

async fn upgrade(
    State(state): State<InternalServerState>,
    websocket: WebSocketUpgrade,
) -> impl IntoResponse {
    websocket.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: InternalServerState) {
    let (mut sender, mut receiver) = socket.split();
    let Some(Ok(Message::Text(first))) = receiver.next().await else {
        return;
    };
    let first_value: Value = match serde_json::from_str(first.as_ref()) {
        Ok(value) => value,
        Err(_) => return,
    };
    let auth = match serde_json::from_value::<ClientFrame>(first_value) {
        Ok(ClientFrame::Auth(auth)) if valid_version(auth.version) => auth,
        _ => return,
    };
    let expected_token = state
        .runtime
        .0
        .lock()
        .ok()
        .map(|runtime| runtime.registration_token.clone());
    if !expected_token
        .as_deref()
        .map(|token| tokens_equal(token, &auth.registration_token))
        .unwrap_or(false)
    {
        return;
    }

    let (writer, mut writer_rx) = unbounded_channel::<String>();
    let writer_task = async_runtime::spawn(async move {
        while let Some(payload) = writer_rx.recv().await {
            if sender.send(Message::Text(payload.into())).await.is_err() {
                break;
            }
        }
    });
    let mut registered = false;
    let mut epoch = String::new();

    while let Some(result) = receiver.next().await {
        let Ok(message) = result else {
            break;
        };
        let Message::Text(text) = message else {
            if matches!(message, Message::Close(_)) {
                break;
            }
            continue;
        };
        let value: Value = match serde_json::from_str(text.as_ref()) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let frame = match serde_json::from_value::<ClientFrame>(value) {
            Ok(frame) => frame,
            Err(_) => continue,
        };
        match &frame {
            ClientFrame::Register(register) if valid_version(register.version) => {
                epoch = register
                    .instance
                    .get("epoch")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if state
                    .registry
                    .register(
                        auth.instance_id.clone(),
                        register.instance.clone(),
                        register.state.clone(),
                        writer.clone(),
                    )
                    .is_ok()
                {
                    registered = true;
                }
            }
            ClientFrame::Heartbeat(heartbeat) if valid_version(heartbeat.version) => {
                let _ = state.registry.heartbeat(
                    &auth.instance_id,
                    heartbeat.instance.clone(),
                    heartbeat.state.clone(),
                );
            }
            ClientFrame::Event(event)
                if valid_version(event.version) && event.instance_id == auth.instance_id =>
            {
                let _ = state.registry.event(&auth.instance_id, event.event.clone());
                if event.event.get("kind").and_then(Value::as_str) == Some("prompt") {
                    if let Some(prompt_id) = event
                        .event
                        .get("promptId")
                        .and_then(Value::as_str)
                        .or_else(|| {
                            event
                                .event
                                .get("prompt")
                                .and_then(|prompt| prompt.get("id"))
                                .and_then(Value::as_str)
                        })
                    {
                        push::notify_pending_prompt(
                            state.app.clone(),
                            state.runtime.clone(),
                            prompt_id,
                        );
                    }
                }
            }
            ClientFrame::Unregister(unregister)
                if valid_version(unregister.version)
                    && unregister.instance_id == auth.instance_id =>
            {
                let _ = state
                    .registry
                    .unregister(&auth.instance_id, &unregister.epoch);
                registered = false;
                break;
            }
            ClientFrame::Command(command)
                if valid_version(command.version) && command.instance_id == auth.instance_id =>
            {
                handle_command(&state, command, &writer).await;
            }
            ClientFrame::MessageAck(ack) if valid_version(ack.version) => {
                state.registry.resolve_client_frame(&frame)
            }
            ClientFrame::PromptAnswerAck(ack) if valid_version(ack.version) => {
                state.registry.resolve_client_frame(&frame)
            }
            ClientFrame::CommandResult(result) if valid_version(result.version) => {
                state.registry.resolve_client_frame(&frame)
            }
            _ => {}
        }
    }

    if registered {
        let _ = state.registry.unregister(&auth.instance_id, &epoch);
    }
    writer_task.abort();
}

async fn handle_command(
    state: &InternalServerState,
    command: &crate::protocol::CommandFrame,
    writer: &tokio::sync::mpsc::UnboundedSender<String>,
) {
    let mut result = CommandResultFrame {
        r#type: Some("command_result".to_string()),
        version: PROTOCOL_VERSION,
        request_id: command.request_id.clone(),
        ok: false,
        message: "Command is not available.".to_string(),
        pairing_uri: None,
        instances: None,
        history: None,
        state: None,
    };
    match command.command.as_str() {
        "status" => {
            result.ok = true;
            result.message = "Companion is running.".to_string();
            result.instances = state.registry.list().ok();
        }
        "pair" | "show_pairing" => match state.runtime.0.lock() {
            Ok(mut runtime) => match ensure_public_access(&mut runtime)
                .and_then(|()| create_pairing_uri(&mut runtime))
                .and_then(|uri| persist(&state.app, &runtime.persisted).map(|()| uri))
                .and_then(|uri| rendezvous::write(&state.app, &runtime).map(|()| uri))
            {
                Ok(uri) => {
                    result.ok = true;
                    result.message = "A new Pimo pairing QR is ready.".to_string();
                    result.pairing_uri = Some(uri);
                }
                Err(error) => result.message = error,
            },
            Err(_) => result.message = "Companion state lock is poisoned.".to_string(),
        },
        "set_enabled" => {
            if let Ok(mut runtime) = state.runtime.0.lock() {
                runtime.persisted.enabled = command.enabled.unwrap_or(true);
                match persist(&state.app, &runtime.persisted) {
                    Ok(()) => {
                        result.ok = true;
                        result.message = "Pimo setting updated.".to_string();
                    }
                    Err(error) => result.message = error,
                }
            }
        }
        "off" => {
            if let Ok(mut runtime) = state.runtime.0.lock() {
                revoke_device(&mut runtime);
                runtime.persisted.enabled = false;
                let tailscale_message =
                    if runtime.serve_owned || runtime.persisted.owned_serve_port.is_some() {
                        match tailscale::default_executable().and_then(|executable| {
                            tailscale::stop_owned_default(
                                &executable,
                                runtime.persisted.owned_serve_port,
                            )
                        }) {
                            Ok(_) => {
                                runtime.serve_owned = false;
                                runtime.persisted.owned_serve_port = None;
                                None
                            }
                            Err(error) => Some(error),
                        }
                    } else {
                        None
                    };
                runtime.public_base_url = None;
                let persistence = persist(&state.app, &runtime.persisted);
                let rendezvous_result = rendezvous::write(&state.app, &runtime);
                match (persistence, tailscale_message, rendezvous_result) {
                    (Ok(()), None, Ok(())) => {
                        result.ok = true;
                        result.message = "Pimo access was revoked.".to_string();
                    }
                    (Err(error), _, _) => result.message = error,
                    (_, Some(error), _) => {
                        result.message = format!(
                            "Pimo access was revoked, but Tailscale cleanup failed: {error}"
                        )
                    }
                    (_, _, Err(error)) => {
                        result.message = format!(
                            "Pimo access was revoked, but rendezvous cleanup failed: {error}"
                        )
                    }
                }
            }
        }
        _ => {}
    }
    if let Ok(payload) = serde_json::to_string(&result) {
        let _ = writer.send(payload);
    }
}
