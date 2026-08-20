use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u8 = 2;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum ClientFrame {
    #[serde(rename = "auth")]
    Auth(AuthFrame),
    #[serde(rename = "register")]
    Register(RegisterFrame),
    #[serde(rename = "heartbeat")]
    Heartbeat(HeartbeatFrame),
    #[serde(rename = "event")]
    Event(EventFrame),
    #[serde(rename = "unregister")]
    Unregister(UnregisterFrame),
    #[serde(rename = "message_ack")]
    MessageAck(MessageAckFrame),
    #[serde(rename = "prompt_answer_ack")]
    PromptAnswerAck(PromptAnswerAckFrame),
    #[serde(rename = "command_result")]
    CommandResult(CommandResultFrame),
    #[serde(rename = "command")]
    Command(CommandFrame),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthFrame {
    pub version: u8,
    pub registration_token: String,
    pub instance_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisterFrame {
    pub version: u8,
    pub instance: Value,
    pub state: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HeartbeatFrame {
    pub version: u8,
    pub instance: Value,
    pub state: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventFrame {
    pub version: u8,
    pub instance_id: String,
    pub event: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnregisterFrame {
    pub version: u8,
    pub instance_id: String,
    pub epoch: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageAckFrame {
    pub r#type: Option<String>,
    pub version: u8,
    pub request_id: String,
    pub accepted: bool,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromptAnswerAckFrame {
    pub r#type: Option<String>,
    pub version: u8,
    pub prompt_id: String,
    pub request_id: Option<String>,
    pub accepted: bool,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandResultFrame {
    pub r#type: Option<String>,
    pub version: u8,
    pub request_id: String,
    pub ok: bool,
    pub message: String,
    pub pairing_uri: Option<String>,
    pub instances: Option<Vec<Value>>,
    pub history: Option<Value>,
    pub state: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum ServerFrame {
    #[serde(rename = "message")]
    Message(MessageFrame),
    #[serde(rename = "prompt_answer")]
    PromptAnswer(PromptAnswerFrame),
    #[serde(rename = "command")]
    Command(CommandFrame),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageFrame {
    pub version: u8,
    pub instance_id: String,
    pub request_id: String,
    pub text: String,
    pub delivery: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptAnswerFrame {
    pub version: u8,
    pub instance_id: String,
    pub prompt_id: String,
    pub request_id: String,
    pub answer: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandFrame {
    pub version: u8,
    pub request_id: String,
    pub instance_id: String,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

pub fn valid_version(version: u8) -> bool {
    version == PROTOCOL_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_v2_auth_fixture() {
        let frame: ClientFrame = serde_json::from_str(r#"{"type":"auth","version":2,"registrationToken":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","instanceId":"instance-1"}"#).expect("auth fixture");
        match frame {
            ClientFrame::Auth(auth) => assert!(valid_version(auth.version)),
            _ => panic!("wrong frame"),
        }
    }

    #[test]
    fn rejects_unknown_fields_and_old_versions() {
        let unknown = serde_json::from_str::<ClientFrame>(
            r#"{"type":"auth","version":2,"registrationToken":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","instanceId":"instance-1","extra":true}"#,
        );
        assert!(unknown.is_err());
        let old: ClientFrame = serde_json::from_str(r#"{"type":"auth","version":1,"registrationToken":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","instanceId":"instance-1"}"#).expect("old shape parses for version check");
        match old {
            ClientFrame::Auth(auth) => assert!(!valid_version(auth.version)),
            _ => panic!("wrong frame"),
        }
    }

    #[test]
    fn history_command_omits_empty_optional_fields() {
        let value = serde_json::to_value(ServerFrame::Command(CommandFrame {
            version: PROTOCOL_VERSION,
            request_id: "history-1".to_string(),
            instance_id: "instance-1".to_string(),
            command: "history".to_string(),
            enabled: None,
            cursor: None,
            limit: Some(100),
        }))
        .expect("serialize history command");

        assert_eq!(value["type"], "command");
        assert!(value.get("enabled").is_none());
        assert!(value.get("cursor").is_none());
        assert_eq!(value["limit"], 100);
    }
}
