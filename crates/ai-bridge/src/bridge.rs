use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Semaphore;

use crate::prompts::{
    build_compile_rules_request, build_judge_extract_request, build_suggest_fields_request,
    generate_boundary_nonce, split_posts_into_batches, BatchConfig,
};
use crate::schema::{
    validate_compile_rules_output, validate_json_schema, validate_judge_extract_output,
    validate_suggest_fields_output, SchemaCache,
};
use crate::types::{
    AiCallRecord, AiCallStatus, AiError, AiProvider, AiRequest, AiResponse, CompileRulesInput,
    JudgeItemResult, PostPromptInput, ProbeResult, ProviderId, RadarPromptContext,
    SuggestFieldsInput, SuggestFieldsOutput, Usage,
};

pub const MIN_CONCURRENCY: usize = 1;
pub const MAX_CONCURRENCY: usize = 2;

/// Outcome of a single post inside a `judge_extract` batch (`06-ai-bridge.md §4`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum PostEvalOutcome {
    Done {
        post_id: String,
        result: JudgeItemResult,
    },
    AiFailed {
        post_id: String,
        #[serde(rename = "ref")]
        r#ref: u32,
        error: String,
    },
}

/// Aggregated result and telemetry for a single high-level AI task (`suggest_fields`, `compile_rules`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskResult<T> {
    pub output: T,
    pub calls: Vec<AiCallRecord>,
    pub total_usage: Usage,
    pub total_duration: Duration,
}

/// Aggregated report for `judge_extract` batch evaluation, including bisection telemetry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JudgeBatchReport {
    pub outcomes: Vec<PostEvalOutcome>,
    pub calls: Vec<AiCallRecord>,
    pub total_usage: Usage,
    pub total_duration: Duration,
    pub bisection_count: usize,
}

impl JudgeBatchReport {
    fn empty() -> Self {
        Self {
            outcomes: Vec::new(),
            calls: Vec::new(),
            total_usage: Usage::default(),
            total_duration: Duration::ZERO,
            bisection_count: 0,
        }
    }

    fn merge(&mut self, other: JudgeBatchReport) {
        self.outcomes.extend(other.outcomes);
        self.calls.extend(other.calls);
        accumulate_usage(&mut self.total_usage, Some(&other.total_usage));
        self.total_duration += other.total_duration;
        self.bisection_count += other.bisection_count;
    }
}

/// Central AI Bridge orchestrating concurrency limits (`1..=2`), schema caching,
/// 1x output validation retry, and recursive batch bisection (`06-ai-bridge.md §3.1, §4, §5`).
pub struct AiBridge {
    provider: RwLock<Arc<dyn AiProvider>>,
    semaphore: Arc<Semaphore>,
    max_concurrency: usize,
    schema_cache: SchemaCache,
    timeout_override: Option<Duration>,
}

impl std::fmt::Debug for AiBridge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AiBridge")
            .field("provider_id", &self.provider_id())
            .field("max_concurrency", &self.max_concurrency)
            .field("cached_schemas", &self.schema_cache.len())
            .finish()
    }
}

impl AiBridge {
    /// Creates an `AiBridge` with default max concurrency of `1` (`06-ai-bridge.md §3.1`).
    pub fn new(provider: Arc<dyn AiProvider>) -> Self {
        Self::with_concurrency(provider, MIN_CONCURRENCY)
    }

    /// Creates an `AiBridge` with `max_concurrency` clamped to `1..=2` (`06-ai-bridge.md §3.1`).
    pub fn with_concurrency(provider: Arc<dyn AiProvider>, max_concurrency: usize) -> Self {
        let clamped = max_concurrency.clamp(MIN_CONCURRENCY, MAX_CONCURRENCY);
        Self {
            provider: RwLock::new(provider),
            semaphore: Arc::new(Semaphore::new(clamped)),
            max_concurrency: clamped,
            schema_cache: SchemaCache::new(),
            timeout_override: None,
        }
    }

    pub fn with_timeout_override(mut self, timeout: Duration) -> Self {
        self.timeout_override = Some(timeout);
        self
    }

    pub fn max_concurrency(&self) -> usize {
        self.max_concurrency
    }

    pub fn schema_cache(&self) -> &SchemaCache {
        &self.schema_cache
    }

    pub fn provider(&self) -> Arc<dyn AiProvider> {
        self.provider
            .read()
            .expect("provider RwLock poisoned")
            .clone()
    }

    pub fn provider_id(&self) -> ProviderId {
        self.provider().id()
    }

    pub fn set_provider(&self, provider: Arc<dyn AiProvider>) {
        *self.provider.write().expect("provider RwLock poisoned") = provider;
    }

    pub async fn probe(&self) -> ProbeResult {
        let _permit = self
            .semaphore
            .acquire()
            .await
            .expect("AiBridge semaphore never closed");
        self.provider().probe().await
    }

    /// Low-level call acquiring the concurrency semaphore, validating `resp.output` against
    /// `req.schema`, and retrying **once** on `AiError::InvalidOutput`.
    pub async fn complete_validated(
        &self,
        req: AiRequest,
        radar_version_id: Option<&str>,
        item_count: usize,
    ) -> Result<TaskResult<Value>, AiError> {
        let mut calls = Vec::with_capacity(2);
        let mut total_usage = Usage::default();
        let mut total_duration = Duration::ZERO;

        for attempt in 0..2 {
            let (res, record) = self
                .invoke_once(req.clone(), radar_version_id, item_count)
                .await;
            total_duration += Duration::from_millis(record.duration_ms);
            let call_usage = record_to_usage(&record);
            accumulate_usage(&mut total_usage, call_usage.as_ref());
            calls.push(record);

            match res {
                Ok(resp) => {
                    return Ok(TaskResult {
                        output: resp.output,
                        calls,
                        total_usage,
                        total_duration,
                    });
                }
                Err(AiError::InvalidOutput(_)) if attempt == 0 => {
                    tracing::warn!(
                        task = %req.task,
                        "AI output failed schema validation on attempt 1; retrying once"
                    );
                    continue;
                }
                Err(err) => return Err(err),
            }
        }

        unreachable!("2-attempt loop always returns")
    }

    /// Executes `suggest_fields` (`06-ai-bridge.md §5.1`) with schema + semantic validation and 1x retry.
    pub async fn suggest_fields(
        &self,
        input: &SuggestFieldsInput,
    ) -> Result<TaskResult<SuggestFieldsOutput>, AiError> {
        let mut calls = Vec::with_capacity(2);
        let mut total_usage = Usage::default();
        let mut total_duration = Duration::ZERO;

        for attempt in 0..2 {
            let req = build_suggest_fields_request(input, self.timeout_override);
            let (res, mut record) = self.invoke_once(req, None, 1).await;
            total_duration += Duration::from_millis(record.duration_ms);
            let call_usage = record_to_usage(&record);
            accumulate_usage(&mut total_usage, call_usage.as_ref());

            let parsed_res = match res {
                Ok(resp) => match validate_suggest_fields_output(&resp.output) {
                    Ok(parsed) => Ok(parsed),
                    Err(val_err) => {
                        record.status = AiCallStatus::InvalidOutput;
                        record.error = Some(val_err.to_string());
                        Err(val_err)
                    }
                },
                Err(e) => Err(e),
            };
            calls.push(record);

            match parsed_res {
                Ok(output) => {
                    return Ok(TaskResult {
                        output,
                        calls,
                        total_usage,
                        total_duration,
                    });
                }
                Err(AiError::InvalidOutput(_)) if attempt == 0 => continue,
                Err(err) => return Err(err),
            }
        }

        unreachable!("2-attempt loop always returns")
    }

    /// Executes `compile_rules` (`06-ai-bridge.md §5.3`) with DSL v1 + linear-time regex validation and 1x retry.
    pub async fn compile_rules(
        &self,
        input: &CompileRulesInput,
    ) -> Result<TaskResult<Value>, AiError> {
        let mut calls = Vec::with_capacity(2);
        let mut total_usage = Usage::default();
        let mut total_duration = Duration::ZERO;
        let sample_count = input.labeled_samples.len().max(1);

        for attempt in 0..2 {
            let req = build_compile_rules_request(input, self.timeout_override);
            let (res, mut record) = self
                .invoke_once(req, Some(&input.radar.radar_version_id), sample_count)
                .await;
            total_duration += Duration::from_millis(record.duration_ms);
            let call_usage = record_to_usage(&record);
            accumulate_usage(&mut total_usage, call_usage.as_ref());

            let validated_res = match res {
                Ok(resp) => {
                    match validate_compile_rules_output(&resp.output, &input.radar.fields) {
                        Ok(()) => Ok(resp.output),
                        Err(val_err) => {
                            record.status = AiCallStatus::InvalidOutput;
                            record.error = Some(val_err.to_string());
                            Err(val_err)
                        }
                    }
                }
                Err(e) => Err(e),
            };
            calls.push(record);

            match validated_res {
                Ok(output) => {
                    return Ok(TaskResult {
                        output,
                        calls,
                        total_usage,
                        total_duration,
                    });
                }
                Err(AiError::InvalidOutput(_)) if attempt == 0 => continue,
                Err(err) => return Err(err),
            }
        }

        unreachable!("2-attempt loop always returns")
    }

    /// Splits `posts` according to `batch_config` (`20` live / `10` preview, `<= 24,000` chars)
    /// and evaluates every batch with 1x retry + recursive bisection (`06-ai-bridge.md §4, §5.2`).
    pub async fn judge_extract_all(
        &self,
        radar: &RadarPromptContext,
        posts: &[PostPromptInput],
        batch_config: &BatchConfig,
    ) -> Result<JudgeBatchReport, AiError> {
        let chunks = split_posts_into_batches(radar, posts, batch_config);
        let mut combined = JudgeBatchReport::empty();
        for chunk in chunks {
            let report = self.judge_extract_batch(radar, &chunk).await?;
            combined.merge(report);
        }
        Ok(combined)
    }

    /// Evaluates a single batch of posts for `radar`:
    /// - Retries **once** on `InvalidOutput` / `Refused`.
    /// - If retry still fails and `posts.len() > 1`, **recursively bisects** into two halves
    ///   (`06-ai-bridge.md §4`) so a single poison/malformed post is isolated as `AiFailed`
    ///   while all valid posts in the batch succeed!
    pub async fn judge_extract_batch(
        &self,
        radar: &RadarPromptContext,
        posts: &[PostPromptInput],
    ) -> Result<JudgeBatchReport, AiError> {
        if posts.is_empty() {
            return Ok(JudgeBatchReport::empty());
        }

        // Ensure unique `ref` numbers across the batch while remembering caller's original `ref`s.
        let normalized_posts = ensure_unique_refs(posts);
        let schema = self
            .schema_cache
            .get_or_build(&radar.radar_version_id, &radar.fields);

        self.eval_slice_recursive(radar, &normalized_posts, posts, &schema)
            .await
    }

    fn eval_slice_recursive<'a>(
        &'a self,
        radar: &'a RadarPromptContext,
        slice: &'a [PostPromptInput],
        orig_slice: &'a [PostPromptInput],
        schema: &'a Value,
    ) -> Pin<Box<dyn Future<Output = Result<JudgeBatchReport, AiError>> + Send + 'a>> {
        Box::pin(async move {
            let expected_refs: Vec<u32> = slice.iter().map(|p| p.r#ref).collect();
            let mut report = JudgeBatchReport::empty();
            let mut last_bisectable_err: Option<AiError> = None;

            for attempt in 0..2 {
                let nonce = generate_boundary_nonce();
                let req = build_judge_extract_request(
                    radar,
                    slice,
                    schema.clone(),
                    &nonce,
                    self.timeout_override,
                );
                let (res, mut record) = self
                    .invoke_once(req, Some(&radar.radar_version_id), slice.len())
                    .await;

                report.total_duration += Duration::from_millis(record.duration_ms);
                let call_usage = record_to_usage(&record);
                accumulate_usage(&mut report.total_usage, call_usage.as_ref());

                let validated = match res {
                    Ok(resp) => {
                        match validate_judge_extract_output(
                            &resp.output,
                            &expected_refs,
                            &radar.fields,
                        ) {
                            Ok(parsed) => Ok(parsed),
                            Err(task_err) => {
                                record.status = AiCallStatus::InvalidOutput;
                                record.error = Some(task_err.to_string());
                                Err(task_err)
                            }
                        }
                    }
                    Err(e) => Err(e),
                };
                report.calls.push(record);

                match validated {
                    Ok(parsed_out) => {
                        let mut by_ref: HashMap<u32, JudgeItemResult> = parsed_out
                            .results
                            .into_iter()
                            .map(|item| (item.r#ref, item))
                            .collect();

                        for (norm_post, orig_post) in slice.iter().zip(orig_slice.iter()) {
                            let mut item = by_ref
                                .remove(&norm_post.r#ref)
                                .expect("validated exact ref presence");
                            item.r#ref = orig_post.r#ref;
                            report.outcomes.push(PostEvalOutcome::Done {
                                post_id: orig_post.post_id.clone(),
                                result: item,
                            });
                        }
                        return Ok(report);
                    }
                    Err(err) if err.is_bisectable_batch_failure() => {
                        last_bisectable_err = Some(err);
                        if attempt == 0 {
                            tracing::warn!(
                                batch_len = slice.len(),
                                "judge_extract batch failed validation on attempt 1; retrying once"
                            );
                            continue;
                        }
                    }
                    Err(fatal_err) => {
                        return Err(fatal_err);
                    }
                }
            }

            // Both initial attempt and 1x retry failed with a bisectable error (`InvalidOutput` / `Refused`).
            let err_msg = last_bisectable_err
                .map(|e| e.to_string())
                .unwrap_or_else(|| "invalid AI output".to_string());

            if slice.len() == 1 {
                let single_orig = &orig_slice[0];
                report.outcomes.push(PostEvalOutcome::AiFailed {
                    post_id: single_orig.post_id.clone(),
                    r#ref: single_orig.r#ref,
                    error: err_msg,
                });
                return Ok(report);
            }

            // Bisect into left and right halves (`06-ai-bridge.md §4`).
            let mid = slice.len() / 2;
            tracing::warn!(
                batch_len = slice.len(),
                left_len = mid,
                right_len = slice.len() - mid,
                "judge_extract retry failed; bisecting batch to isolate bad post"
            );
            report.bisection_count += 1;

            let left_report = self
                .eval_slice_recursive(radar, &slice[..mid], &orig_slice[..mid], schema)
                .await?;
            let right_report = self
                .eval_slice_recursive(radar, &slice[mid..], &orig_slice[mid..], schema)
                .await?;

            report.merge(left_report);
            report.merge(right_report);
            Ok(report)
        })
    }

    async fn invoke_once(
        &self,
        req: AiRequest,
        radar_version_id: Option<&str>,
        item_count: usize,
    ) -> (Result<AiResponse, AiError>, AiCallRecord) {
        let provider = self.provider();
        let provider_id = provider.id();
        let task = req.task;
        let schema = req.schema.clone();

        // Hold semaphore ONLY during the single provider subprocess call so recursive bisection
        // never deadlocks!
        let started = Instant::now();
        let raw_res = {
            let _permit = self
                .semaphore
                .acquire()
                .await
                .expect("AiBridge semaphore never closed");
            provider.complete(req).await
        };
        let wall_duration = started.elapsed();

        let checked_res = match raw_res {
            Ok(resp) => match validate_json_schema(&schema, &resp.output) {
                Ok(()) => Ok(resp),
                Err(schema_err) => Err(AiError::InvalidOutput(schema_err)),
            },
            Err(e) => Err(e),
        };

        let record = match &checked_res {
            Ok(resp) => AiCallRecord {
                provider: provider_id,
                model: resp.model.clone(),
                task,
                radar_version_id: radar_version_id.map(ToOwned::to_owned),
                item_count,
                input_tokens: resp.usage.as_ref().map(|u| u.input_tokens),
                output_tokens: resp.usage.as_ref().map(|u| u.output_tokens),
                cost_usd: resp.usage.as_ref().and_then(|u| u.cost_usd),
                duration_ms: resp.duration.as_millis().max(wall_duration.as_millis()) as u64,
                status: AiCallStatus::Ok,
                error: None,
            },
            Err(err) => AiCallRecord {
                provider: provider_id,
                model: None,
                task,
                radar_version_id: radar_version_id.map(ToOwned::to_owned),
                item_count,
                input_tokens: None,
                output_tokens: None,
                cost_usd: None,
                duration_ms: wall_duration.as_millis() as u64,
                status: err.call_status(),
                error: Some(err.to_string()),
            },
        };

        (checked_res, record)
    }
}

fn ensure_unique_refs(posts: &[PostPromptInput]) -> Vec<PostPromptInput> {
    let mut seen = HashSet::with_capacity(posts.len());
    let all_unique = posts.iter().all(|p| seen.insert(p.r#ref));
    if all_unique {
        return posts.to_vec();
    }
    posts
        .iter()
        .enumerate()
        .map(|(idx, p)| {
            let mut copy = p.clone();
            copy.r#ref = (idx + 1) as u32;
            copy
        })
        .collect()
}

fn record_to_usage(rec: &AiCallRecord) -> Option<Usage> {
    if rec.input_tokens.is_none() && rec.output_tokens.is_none() && rec.cost_usd.is_none() {
        return None;
    }
    Some(Usage {
        input_tokens: rec.input_tokens.unwrap_or(0),
        output_tokens: rec.output_tokens.unwrap_or(0),
        cost_usd: rec.cost_usd,
    })
}

fn accumulate_usage(acc: &mut Usage, delta: Option<&Usage>) {
    let Some(d) = delta else {
        return;
    };
    acc.input_tokens += d.input_tokens;
    acc.output_tokens += d.output_tokens;
    if let Some(c) = d.cost_usd {
        acc.cost_usd = Some(acc.cost_usd.unwrap_or(0.0) + c);
    }
}
