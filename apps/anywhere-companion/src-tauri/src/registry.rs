use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{mpsc::UnboundedSender, oneshot};

use crate::protocol::{ClientFrame, ServerFrame};

pub const INSTANCE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_LIVE_EVENTS: usize = 500;

pub struct InstanceRecord {
    pub instance: Value,
    pub state: Value,
    pub last_heartbeat: Instant,
    pub sender: UnboundedSender<String>,
}

pub struct Registry {
    pub instances: HashMap<String, InstanceRecord>,
    pub waiters: HashMap<String, oneshot::Sender<Value>>,
}

#[derive(Clone)]
pub struct RegistryState(pub Arc<Mutex<Registry>>);

pub struct WaiterGuard {
    registry: RegistryState,
    request_id: String,
}

impl Drop for WaiterGuard {
    fn drop(&mut self) {
        self.registry.cancel_waiter(&self.request_id);
    }
}

impl Default for RegistryState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(Registry {
            instances: HashMap::new(),
            waiters: HashMap::new(),
        })))
    }
}

impl RegistryState {
    pub fn register_waiter(&self, request_id: String) -> Result<oneshot::Receiver<Value>, String> {
        let (sender, receiver) = oneshot::channel();
        let mut registry = self
            .0
            .lock()
            .map_err(|_| "Instance registry lock is poisoned".to_string())?;
        if registry.waiters.contains_key(&request_id) {
            return Err("A request with this identifier is already pending".to_string());
        }
        registry.waiters.insert(request_id, sender);
        Ok(receiver)
    }

    pub fn register_scoped_waiter(
        &self,
        request_id: String,
    ) -> Result<(WaiterGuard, oneshot::Receiver<Value>), String> {
        let receiver = self.register_waiter(request_id.clone())?;
        Ok((
            WaiterGuard {
                registry: self.clone(),
                request_id,
            },
            receiver,
        ))
    }

    pub fn resolve_waiter(&self, request_id: &str, value: Value) {
        if let Ok(mut registry) = self.0.lock() {
            if let Some(sender) = registry.waiters.remove(request_id) {
                let _ = sender.send(value);
            }
        }
    }

    pub fn cancel_waiter(&self, request_id: &str) {
        if let Ok(mut registry) = self.0.lock() {
            registry.waiters.remove(request_id);
        }
    }

    pub fn register(
        &self,
        instance_id: String,
        instance: Value,
        state: Value,
        sender: UnboundedSender<String>,
    ) -> Result<(), String> {
        let mut registry = self
            .0
            .lock()
            .map_err(|_| "Instance registry lock is poisoned".to_string())?;
        registry.instances.insert(
            instance_id,
            InstanceRecord {
                instance,
                state,
                last_heartbeat: Instant::now(),
                sender,
            },
        );
        Ok(())
    }

    pub fn heartbeat(
        &self,
        instance_id: &str,
        instance: Value,
        state: Value,
    ) -> Result<bool, String> {
        let mut registry = self
            .0
            .lock()
            .map_err(|_| "Instance registry lock is poisoned".to_string())?;
        let Some(record) = registry.instances.get_mut(instance_id) else {
            return Ok(false);
        };
        record.instance = instance;
        match (record.state.as_object_mut(), state.as_object()) {
            (Some(current), Some(update)) => {
                // Heartbeats intentionally omit the event list. Merge their live fields
                // into the registered full state instead of replacing that state.
                current.remove("question");
                for (key, value) in update {
                    current.insert(key.clone(), value.clone());
                }
            }
            _ => record.state = state,
        }
        record.last_heartbeat = Instant::now();
        Ok(true)
    }

    pub fn event(&self, instance_id: &str, event: Value) -> Result<bool, String> {
        let Some(cursor) = event.get("cursor").and_then(Value::as_u64) else {
            return Ok(false);
        };
        let mut registry = self
            .0
            .lock()
            .map_err(|_| "Instance registry lock is poisoned".to_string())?;
        let Some(record) = registry.instances.get_mut(instance_id) else {
            return Ok(false);
        };
        let Some(state) = record.state.as_object_mut() else {
            return Ok(false);
        };
        if !state.get("events").is_some_and(Value::is_array) {
            state.insert("events".to_string(), json!([]));
        }
        let oldest_cursor = {
            let events = state
                .get_mut("events")
                .and_then(Value::as_array_mut)
                .expect("events was normalized to an array");
            if events
                .iter()
                .any(|existing| existing.get("cursor").and_then(Value::as_u64) == Some(cursor))
            {
                return Ok(true);
            }
            events.push(event);
            if events.len() > MAX_LIVE_EVENTS {
                events.drain(0..events.len() - MAX_LIVE_EVENTS);
            }
            events
                .first()
                .and_then(|item| item.get("cursor"))
                .cloned()
                .unwrap_or_else(|| json!(cursor))
        };
        state.insert("cursor".to_string(), json!(cursor));
        state.insert("oldestCursor".to_string(), oldest_cursor);
        record.last_heartbeat = Instant::now();
        Ok(true)
    }

    pub fn unregister(&self, instance_id: &str, epoch: &str) -> Result<(), String> {
        let mut registry = self
            .0
            .lock()
            .map_err(|_| "Instance registry lock is poisoned".to_string())?;
        let should_remove = registry
            .instances
            .get(instance_id)
            .and_then(|record| record.instance.get("epoch"))
            .and_then(Value::as_str)
            .map(|value| value == epoch)
            .unwrap_or(true);
        if should_remove {
            registry.instances.remove(instance_id);
        }
        Ok(())
    }

    pub fn remove(&self, instance_id: &str) -> Result<bool, String> {
        let mut registry = self
            .0
            .lock()
            .map_err(|_| "Instance registry lock is poisoned".to_string())?;
        Ok(registry.instances.remove(instance_id).is_some())
    }

    pub fn send(&self, instance_id: &str, frame: &ServerFrame) -> Result<bool, String> {
        let payload = serde_json::to_string(frame)
            .map_err(|error| format!("Could not encode internal frame: {error}"))?;
        let registry = self
            .0
            .lock()
            .map_err(|_| "Instance registry lock is poisoned".to_string())?;
        let Some(record) = registry.instances.get(instance_id) else {
            return Ok(false);
        };
        record
            .sender
            .send(payload)
            .map_err(|_| "Pi instance connection closed".to_string())?;
        Ok(true)
    }

    pub fn resolve_client_frame(&self, frame: &ClientFrame) {
        let (request_id, value) = match frame {
            ClientFrame::MessageAck(ack) => (&ack.request_id, json!(ack)),
            ClientFrame::PromptAnswerAck(ack) => {
                let Some(request_id) = ack.request_id.as_ref() else {
                    return;
                };
                (request_id, json!(ack))
            }
            ClientFrame::CommandResult(result) => (&result.request_id, json!(result)),
            _ => return,
        };
        self.resolve_waiter(request_id, value);
    }

    pub fn list(&self) -> Result<Vec<Value>, String> {
        let registry = self
            .0
            .lock()
            .map_err(|_| "Instance registry lock is poisoned".to_string())?;
        Ok(registry
            .instances
            .values()
            .map(|record| record.instance.clone())
            .collect())
    }

    pub fn instance(&self, instance_id: &str) -> Result<Option<Value>, String> {
        let registry = self
            .0
            .lock()
            .map_err(|_| "Instance registry lock is poisoned".to_string())?;
        Ok(registry
            .instances
            .get(instance_id)
            .map(|record| record.instance.clone()))
    }

    pub fn state(&self, instance_id: &str) -> Result<Option<Value>, String> {
        let registry = self
            .0
            .lock()
            .map_err(|_| "Instance registry lock is poisoned".to_string())?;
        Ok(registry
            .instances
            .get(instance_id)
            .map(|record| record.state.clone()))
    }

    pub fn count(&self) -> Result<usize, String> {
        let registry = self
            .0
            .lock()
            .map_err(|_| "Instance registry lock is poisoned".to_string())?;
        Ok(registry.instances.len())
    }

    #[cfg(test)]
    pub fn waiter_count(&self) -> Result<usize, String> {
        let registry = self
            .0
            .lock()
            .map_err(|_| "Instance registry lock is poisoned".to_string())?;
        Ok(registry.waiters.len())
    }

    pub fn remove_stale(&self) -> Result<(), String> {
        let mut registry = self
            .0
            .lock()
            .map_err(|_| "Instance registry lock is poisoned".to_string())?;
        let now = Instant::now();
        registry
            .instances
            .retain(|_, record| now.duration_since(record.last_heartbeat) < INSTANCE_TIMEOUT);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc::unbounded_channel;

    fn registered_state() -> RegistryState {
        let registry = RegistryState::default();
        let (sender, _receiver) = unbounded_channel();
        registry
            .register(
                "instance-1".to_string(),
                json!({ "id": "instance-1", "epoch": "epoch-1", "state": "idle" }),
                json!({
                    "version": 2,
                    "instanceId": "instance-1",
                    "epoch": "epoch-1",
                    "cursor": 1,
                    "oldestCursor": 1,
                    "resetRequired": false,
                    "events": [{ "cursor": 1, "kind": "status", "text": "ready" }],
                    "question": { "id": "prompt-1" },
                    "agent": false
                }),
                sender,
            )
            .expect("register instance");
        registry
    }

    #[test]
    fn heartbeat_merges_without_dropping_full_state() {
        let registry = registered_state();
        assert!(registry
            .heartbeat(
                "instance-1",
                json!({ "id": "instance-1", "epoch": "epoch-1", "state": "working" }),
                json!({
                    "epoch": "epoch-1",
                    "cursor": 1,
                    "oldestCursor": 1,
                    "resetRequired": false,
                    "agent": true
                }),
            )
            .expect("merge heartbeat"));

        let state = registry
            .state("instance-1")
            .expect("read state")
            .expect("registered state");
        assert_eq!(state["version"], 2);
        assert_eq!(state["instanceId"], "instance-1");
        assert_eq!(state["agent"], true);
        assert_eq!(state["events"].as_array().map(Vec::len), Some(1));
        assert!(state.get("question").is_none());
    }

    #[test]
    fn closed_instance_is_removed_from_the_session_list() {
        let registry = registered_state();
        registry
            .unregister("instance-1", "epoch-1")
            .expect("unregister instance");

        assert!(registry.list().expect("list instances").is_empty());
    }

    #[test]
    fn scoped_waiter_is_cancelled_when_the_request_scope_ends() {
        let registry = RegistryState::default();
        let (waiter, _receiver) = registry
            .register_scoped_waiter("request-1".to_string())
            .expect("register waiter");
        assert_eq!(registry.waiter_count().expect("waiter count"), 1);
        assert!(registry
            .register_scoped_waiter("request-1".to_string())
            .is_err());

        drop(waiter);

        assert_eq!(registry.waiter_count().expect("waiter count"), 0);
    }

    #[test]
    fn event_is_retained_and_advances_state_cursor() {
        let registry = registered_state();
        assert!(registry
            .event(
                "instance-1",
                json!({ "cursor": 2, "kind": "message", "id": "message-1", "text": "hello" }),
            )
            .expect("record event"));

        let state = registry
            .state("instance-1")
            .expect("read state")
            .expect("registered state");
        assert_eq!(state["cursor"], 2);
        assert_eq!(state["oldestCursor"], 1);
        assert_eq!(state["events"].as_array().map(Vec::len), Some(2));
    }
}
