use serde_json::Value;
use std::process::Command;

#[derive(Debug, Clone)]
pub struct CommandResult {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

pub trait CommandRunner: Send + Sync {
    fn run(&self, executable: &str, args: &[String]) -> CommandResult;
}

pub struct ProcessRunner;

impl CommandRunner for ProcessRunner {
    fn run(&self, executable: &str, args: &[String]) -> CommandResult {
        match Command::new(executable).args(args).output() {
            Ok(output) => CommandResult {
                code: output.status.code(),
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            },
            Err(error) => CommandResult {
                code: None,
                stdout: String::new(),
                stderr: error.to_string(),
            },
        }
    }
}

pub fn candidates() -> Vec<String> {
    if cfg!(windows) {
        vec![
            "tailscale".to_string(),
            r"C:\Program Files\Tailscale\tailscale.exe".to_string(),
        ]
    } else {
        vec!["tailscale".to_string()]
    }
}

pub fn find(runner: &dyn CommandRunner) -> Result<String, String> {
    for candidate in candidates() {
        let result = runner.run(&candidate, &["--version".to_string()]);
        if result.code == Some(0) {
            return Ok(candidate);
        }
    }
    Err("Tailscale is not installed or is not available on PATH.".to_string())
}

pub fn discover_url(executable: &str, runner: &dyn CommandRunner) -> Result<String, String> {
    let result = runner.run(executable, &["status".to_string(), "--json".to_string()]);
    if result.code != Some(0) {
        return Err("Tailscale is not running.".to_string());
    }
    let status: Value = serde_json::from_str(&result.stdout)
        .map_err(|_| "Tailscale returned unreadable status JSON.".to_string())?;
    if status.get("BackendState").and_then(Value::as_str) != Some("Running") {
        return Err("Tailscale must be connected before Pimo can start.".to_string());
    }
    let dns_name = status
        .get("Self")
        .and_then(|self_value| self_value.get("DNSName"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim_end_matches('.');
    if dns_name.is_empty() {
        return Err("Tailscale has no MagicDNS name for this computer.".to_string());
    }
    Ok(format!("https://{dns_name}"))
}

fn handler_proxies(value: &Value, proxies: &mut Vec<Option<String>>) {
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                if key == "Handlers" {
                    let Some(handlers) = child.as_object() else {
                        proxies.push(None);
                        continue;
                    };
                    for handler in handlers.values() {
                        let proxy = handler
                            .as_object()
                            .filter(|object| object.len() == 1)
                            .and_then(|object| object.get("Proxy"))
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        proxies.push(proxy);
                    }
                } else {
                    handler_proxies(child, proxies);
                }
            }
        }
        Value::Array(items) => {
            for child in items {
                handler_proxies(child, proxies);
            }
        }
        _ => {}
    }
}

fn serve_is_empty(value: &Value) -> bool {
    value.as_object().is_some_and(|object| object.is_empty())
}

fn serve_matches_owned_route(value: &Value, port: u16) -> bool {
    let mut proxies = Vec::new();
    handler_proxies(value, &mut proxies);
    let expected = format!("http://127.0.0.1:{port}");
    proxies.len() == 1 && proxies[0].as_deref() == Some(expected.as_str())
}

fn serve_status(executable: &str, runner: &dyn CommandRunner) -> Result<Value, String> {
    let result = runner.run(
        executable,
        &[
            "serve".to_string(),
            "status".to_string(),
            "--json".to_string(),
        ],
    );
    if result.code != Some(0) {
        return Err("Could not inspect Tailscale Serve configuration.".to_string());
    }
    serde_json::from_str(&result.stdout)
        .map_err(|_| "Tailscale returned unreadable Serve JSON.".to_string())
}

fn turn_off_serve(executable: &str, runner: &dyn CommandRunner) -> Result<bool, String> {
    let result = runner.run(
        executable,
        &[
            "serve".to_string(),
            "--https=443".to_string(),
            "off".to_string(),
        ],
    );
    if result.code == Some(0) {
        return Ok(true);
    }
    let output = format!("{}\n{}", result.stdout, result.stderr);
    if output
        .to_ascii_lowercase()
        .contains("handler does not exist")
        || output.to_ascii_lowercase().contains("handler not found")
    {
        return Ok(false);
    }
    Err("Tailscale could not remove Pimo's private HTTPS route.".to_string())
}

pub fn ensure_available_serve(
    executable: &str,
    owned_port: Option<u16>,
    runner: &dyn CommandRunner,
) -> Result<(), String> {
    let value = serve_status(executable, runner)?;
    if serve_is_empty(&value) {
        return Ok(());
    }
    if owned_port.is_some_and(|port| serve_matches_owned_route(&value, port)) {
        turn_off_serve(executable, runner)?;
        return Ok(());
    }
    Err(
        "Tailscale Serve is already configured and is not the exact route recorded as Pimo-owned; Pimo will not overwrite it."
            .to_string(),
    )
}

pub fn start_serve(executable: &str, port: u16, runner: &dyn CommandRunner) -> Result<(), String> {
    let result = runner.run(
        executable,
        &[
            "serve".to_string(),
            "--https=443".to_string(),
            "--bg".to_string(),
            format!("http://127.0.0.1:{port}"),
        ],
    );
    if result.code == Some(0) {
        return Ok(());
    }
    if let Some(url) = result
        .stdout
        .split_whitespace()
        .find(|part| part.starts_with("https://login.tailscale.com/"))
    {
        return Err(format!("Tailscale Serve approval is required: {url}"));
    }
    Err(format!(
        "Tailscale could not start private HTTPS: {}",
        result.stderr.trim()
    ))
}

pub fn stop_owned_serve(
    executable: &str,
    owned_port: Option<u16>,
    runner: &dyn CommandRunner,
) -> Result<bool, String> {
    let value = serve_status(executable, runner)?;
    if serve_is_empty(&value) {
        return Ok(false);
    }
    let Some(port) = owned_port else {
        return Err(
            "Pimo has no ownership record for the current Tailscale Serve configuration; refusing to remove it."
                .to_string(),
        );
    };
    if !serve_matches_owned_route(&value, port) {
        return Err(
            "The current Tailscale Serve configuration does not match Pimo's ownership record; refusing to remove it."
                .to_string(),
        );
    }
    turn_off_serve(executable, runner)
}

pub fn default_executable() -> Result<String, String> {
    find(&ProcessRunner)
}

pub fn discover_default_url(executable: &str) -> Result<String, String> {
    discover_url(executable, &ProcessRunner)
}

pub fn ensure_available_default(executable: &str, owned_port: Option<u16>) -> Result<(), String> {
    ensure_available_serve(executable, owned_port, &ProcessRunner)
}

pub fn start_default(executable: &str, port: u16) -> Result<(), String> {
    start_serve(executable, port, &ProcessRunner)
}

pub fn stop_owned_default(executable: &str, owned_port: Option<u16>) -> Result<bool, String> {
    stop_owned_serve(executable, owned_port, &ProcessRunner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct FakeRunner {
        responses: Mutex<Vec<CommandResult>>,
    }

    impl FakeRunner {
        fn new(responses: Vec<CommandResult>) -> Self {
            Self {
                responses: Mutex::new(responses),
            }
        }
    }

    impl CommandRunner for FakeRunner {
        fn run(&self, _executable: &str, _args: &[String]) -> CommandResult {
            self.responses.lock().expect("fake lock").remove(0)
        }
    }

    #[test]
    fn discovers_magic_dns_url_from_status_fixture() {
        let runner = FakeRunner::new(vec![CommandResult {
            code: Some(0),
            stdout: r#"{"BackendState":"Running","Self":{"DNSName":"desktop.tailnet.ts.net."}}"#
                .to_string(),
            stderr: String::new(),
        }]);
        assert_eq!(
            discover_url("tailscale", &runner).expect("url"),
            "https://desktop.tailnet.ts.net"
        );
    }

    #[test]
    fn refuses_existing_serve_configuration_without_ownership() {
        let runner = FakeRunner::new(vec![CommandResult {
            code: Some(0),
            stdout: r#"{"Web":{"desktop.example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:65534"}}}}}"#.to_string(),
            stderr: String::new(),
        }]);
        assert!(ensure_available_serve("tailscale", None, &runner).is_err());
    }

    #[test]
    fn clears_only_the_exact_recorded_owned_route_before_starting() {
        let runner = FakeRunner::new(vec![
            CommandResult {
                code: Some(0),
                stdout: r#"{"Web":{"desktop.example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:65534"}}}}}"#.to_string(),
                stderr: String::new(),
            },
            CommandResult {
                code: Some(0),
                stdout: String::new(),
                stderr: String::new(),
            },
        ]);
        assert!(ensure_available_serve("tailscale", Some(65534), &runner).is_ok());
    }

    #[test]
    fn refuses_to_clear_a_route_that_differs_from_the_ownership_record() {
        let runner = FakeRunner::new(vec![CommandResult {
            code: Some(0),
            stdout: r#"{"Web":{"desktop.example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:65535"}}}}}"#.to_string(),
            stderr: String::new(),
        }]);
        assert!(ensure_available_serve("tailscale", Some(65534), &runner).is_err());
    }

    #[test]
    fn refuses_to_clear_an_owned_proxy_when_an_extra_handler_exists() {
        let runner = FakeRunner::new(vec![CommandResult {
            code: Some(0),
            stdout: r#"{"Web":{"desktop.example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:65534"},"/other":{"Text":"unrelated"}}}}}"#.to_string(),
            stderr: String::new(),
        }]);
        assert!(ensure_available_serve("tailscale", Some(65534), &runner).is_err());
    }

    #[test]
    fn refuses_to_stop_an_unowned_route() {
        let runner = FakeRunner::new(vec![CommandResult {
            code: Some(0),
            stdout: r#"{"Web":{"desktop.example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:65534"}}}}}"#.to_string(),
            stderr: String::new(),
        }]);
        assert!(stop_owned_serve("tailscale", None, &runner).is_err());
    }

    #[test]
    fn treats_an_empty_configuration_as_already_stopped() {
        let runner = FakeRunner::new(vec![CommandResult {
            code: Some(0),
            stdout: "{}".to_string(),
            stderr: String::new(),
        }]);
        assert!(!stop_owned_serve("tailscale", Some(65534), &runner).expect("shutdown"));
    }
}
