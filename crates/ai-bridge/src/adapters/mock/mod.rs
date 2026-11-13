use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use regex::Regex;
use serde_json::{json, Value};

use crate::schema::validate_json_schema;
use crate::types::{
    AiError, AiProvider, AiRequest, AiResponse, ProbeResult, ProviderId, TaskKind, Usage,
};

mod compile;
mod extract;
mod judge;
mod suggest;

use compile::*;
use extract::*;
use judge::*;
use suggest::*;

type CustomHandler = Arc<dyn Fn(&AiRequest) -> Result<AiResponse, AiError> + Send + Sync>;

/// Deterministic offline `AiProvider` supporting both scripted test replay and a realistic
/// Vietnamese heuristic engine for `suggest_fields`, `judge_extract`, and `compile_rules`.
#[derive(Clone)]
pub struct MockAiProvider {
    queue: Arc<Mutex<VecDeque<Result<AiResponse, AiError>>>>,
    recorded: Arc<Mutex<Vec<AiRequest>>>,
    probe_override: Arc<Mutex<Option<ProbeResult>>>,
    handler: Option<CustomHandler>,
}

impl std::fmt::Debug for MockAiProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MockAiProvider")
            .field(
                "queued_len",
                &self.queue.lock().map(|q| q.len()).unwrap_or(0),
            )
            .field(
                "recorded_len",
                &self.recorded.lock().map(|r| r.len()).unwrap_or(0),
            )
            .finish()
    }
}

impl Default for MockAiProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl MockAiProvider {
    pub fn new() -> Self {
        Self {
            queue: Arc::new(Mutex::new(VecDeque::new())),
            recorded: Arc::new(Mutex::new(Vec::new())),
            probe_override: Arc::new(Mutex::new(None)),
            handler: None,
        }
    }

    pub fn with_queued_responses(
        responses: impl IntoIterator<Item = Result<AiResponse, AiError>>,
    ) -> Self {
        let p = Self::new();
        {
            let mut q = p.queue.lock().expect("mock queue lock");
            q.extend(responses);
        }
        p
    }

    pub fn with_handler<F>(handler: F) -> Self
    where
        F: Fn(&AiRequest) -> Result<AiResponse, AiError> + Send + Sync + 'static,
    {
        let mut p = Self::new();
        p.handler = Some(Arc::new(handler));
        p
    }

    pub fn push_response(&self, resp: Result<AiResponse, AiError>) {
        self.queue.lock().expect("mock queue lock").push_back(resp);
    }

    pub fn push_json(&self, output: Value) {
        self.push_response(Ok(AiResponse {
            output,
            usage: Some(Usage {
                input_tokens: 120,
                output_tokens: 60,
                cost_usd: Some(0.0),
            }),
            model: Some("mock-v1".to_string()),
            duration: Duration::from_millis(5),
        }));
    }

    pub fn set_probe_result(&self, probe: ProbeResult) {
        *self.probe_override.lock().expect("probe lock") = Some(probe);
    }

    pub fn recorded_requests(&self) -> Vec<AiRequest> {
        self.recorded.lock().expect("recorded lock").clone()
    }

    pub fn call_count(&self) -> usize {
        self.recorded.lock().expect("recorded lock").len()
    }

    /// Runs the built-in deterministic heuristic engine for any `AiRequest`.
    pub fn heuristic_complete(req: &AiRequest) -> Result<AiResponse, AiError> {
        // Handle `probe()` smoke schema `{"ok": boolean}`
        if req
            .schema
            .get("properties")
            .and_then(|p| p.get("ok"))
            .is_some()
            && req
                .schema
                .get("properties")
                .and_then(Value::as_object)
                .map_or(false, |m| m.len() == 1)
        {
            let output = json!({ "ok": true });
            return Ok(AiResponse {
                output,
                usage: Some(Usage {
                    input_tokens: 24,
                    output_tokens: 6,
                    cost_usd: Some(0.0),
                }),
                model: Some("mock-fast-v1".to_string()),
                duration: Duration::from_millis(3),
            });
        }

        let output = match req.task {
            TaskKind::SuggestFields => heuristic_suggest_fields(&req.prompt),
            TaskKind::JudgeExtract => heuristic_judge_extract(&req.prompt, &req.schema),
            TaskKind::CompileRules => heuristic_compile_rules(&req.prompt),
        };

        validate_json_schema(&req.schema, &output).map_err(AiError::InvalidOutput)?;

        let in_tokens = ((req.system.len() + req.prompt.len()) / 4).max(16) as u64;
        let out_tokens = (output.to_string().len() / 4).max(12) as u64;

        Ok(AiResponse {
            output,
            usage: Some(Usage {
                input_tokens: in_tokens,
                output_tokens: out_tokens,
                cost_usd: Some(0.0),
            }),
            model: Some(match req.tier {
                crate::types::ModelTier::Fast => "mock-fast-v1".to_string(),
                crate::types::ModelTier::Smart => "mock-smart-v1".to_string(),
            }),
            duration: Duration::from_millis(4),
        })
    }
}

#[async_trait]
impl AiProvider for MockAiProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Mock
    }

    async fn probe(&self) -> ProbeResult {
        if let Some(custom) = self.probe_override.lock().expect("probe lock").clone() {
            return custom;
        }
        ProbeResult {
            installed: true,
            version: Some("dealsonar-mock 0.1.0".to_string()),
            authenticated: true,
            flags_supported: true,
            latency_ms: Some(1),
            error: None,
            available_models: crate::adapters::discover_mock_models(),
        }
    }

    async fn complete(&self, req: AiRequest) -> Result<AiResponse, AiError> {
        self.recorded
            .lock()
            .expect("recorded lock")
            .push(req.clone());

        if let Some(queued) = self.queue.lock().expect("mock queue lock").pop_front() {
            return queued;
        }

        if let Some(ref handler) = self.handler {
            return handler(&req);
        }

        Self::heuristic_complete(&req)
    }
}
