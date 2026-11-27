use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::engine::{compile_ruleset_unchecked, validate_ruleset, RulesetBody, RulesetOutcome};
use crate::normalize::{fold_with_spans, normalize_text};
use crate::postfilter::values_equivalent;
use crate::types::FieldDef;

/// Maximum false negative rate allowed at the candidate -> shadow gate (`<= 2%`, `05-pipeline-rules.md §6.4`).
pub const GATE_MAX_FALSE_NEGATIVE_RATE: f64 = 0.02;
/// Minimum precision of `DefiniteMatch` allowed at the gate (`>= 95%`, `05-pipeline-rules.md §6.4`).
pub const GATE_MIN_ACCEPT_PRECISION: f64 = 0.95;
/// Minimum per-field accuracy required to retain an extractor in `extract` (`>= 90%`, `05-pipeline-rules.md §6.4`).
pub const GATE_MIN_FIELD_ACCURACY: f64 = 0.90;

/// Holdout labeled post sample for evaluating a candidate or shadow ruleset (`05-pipeline-rules.md §6.4`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LabeledSample {
    pub post_text: String,
    #[serde(default)]
    pub ref_ts_ms: i64,
    /// Ground-truth match verdict (`true = match`, `false = no_match`).
    pub is_match: bool,
    /// Ground-truth normalized field values (`field_key -> normalized JSON value`).
    #[serde(default)]
    pub expected_fields: BTreeMap<String, Value>,
}

/// Gate evaluation metrics and automatically pruned [`RulesetBody`] (`05-pipeline-rules.md §6.4`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GateReport {
    pub passed: bool,
    pub validation_error: Option<String>,
    pub total_samples: usize,
    /// Fraction of positive (`is_match = true`) samples wrongly rejected (`<= 0.02` required).
    pub false_negative_rate: f64,
    /// Precision among `DefiniteMatch` decisions (`>= 0.95` required).
    pub accept_precision: f64,
    /// Fraction of samples decided directly by the ruleset without calling AI (`PrefilterReject`,
    /// `DefiniteMatch`, or `DefiniteNoMatch`).
    pub self_handled_rate: f64,
    /// Per-field extraction accuracy (`0.0..=1.0`) measured before pruning.
    pub field_accuracies: BTreeMap<String, f64>,
    /// Fields removed from `extract` because their accuracy was `< 0.90`.
    pub dropped_fields: Vec<String>,
    /// Ruleset with `< 90%` accurate field extractors automatically pruned (`05-pipeline-rules.md §6.4`).
    pub pruned_ruleset: RulesetBody,
}

/// Evaluate a candidate/shadow ruleset against labeled holdout samples (`05-pipeline-rules.md §6.4`).
///
/// Checks:
/// - Schema, regex safety, and `< 1ms` execution latency via [`validate_ruleset`]
/// - Per-field accuracy `>= 0.90` (automatically pruning fields `< 0.90` from `pruned_ruleset.extract`)
/// - `false_negative_rate <= 0.02`
/// - `accept_precision >= 0.95`
pub fn evaluate_gate(ruleset: &RulesetBody, labeled_samples: &[LabeledSample]) -> GateReport {
    evaluate_gate_with_fields(ruleset, &[], labeled_samples)
}

/// Evaluate the lifecycle gate with explicit radar [`FieldDef`]s (so `DefiniteMatch` also enforces
/// presence of all `required` fields).
pub fn evaluate_gate_with_fields(
    ruleset: &RulesetBody,
    field_defs: &[FieldDef],
    labeled_samples: &[LabeledSample],
) -> GateReport {
    let compiled_initial = match validate_ruleset(ruleset) {
        Ok(c) => c,
        Err(err) => {
            return GateReport {
                passed: false,
                validation_error: Some(err.to_string()),
                total_samples: labeled_samples.len(),
                false_negative_rate: 1.0,
                accept_precision: 0.0,
                self_handled_rate: 0.0,
                field_accuracies: BTreeMap::new(),
                dropped_fields: Vec::new(),
                pruned_ruleset: ruleset.clone(),
            };
        }
    };

    if labeled_samples.is_empty() {
        return GateReport {
            passed: false,
            validation_error: Some("labeled_samples must not be empty".to_string()),
            total_samples: 0,
            false_negative_rate: 0.0,
            accept_precision: 1.0,
            self_handled_rate: 0.0,
            field_accuracies: BTreeMap::new(),
            dropped_fields: Vec::new(),
            pruned_ruleset: ruleset.clone(),
        };
    }

    let prepared: Vec<_> = labeled_samples
        .iter()
        .map(|s| {
            let norm = normalize_text(&s.post_text);
            let folded = fold_with_spans(&norm.text_norm);
            let ts = if s.ref_ts_ms > 0 {
                s.ref_ts_ms
            } else {
                1_794_384_000_000
            };
            (s, norm, folded, ts)
        })
        .collect();

    // 1. Measure per-field accuracy across extractors
    let mut candidate_field_keys: Vec<String> = Vec::new();
    for ext in &ruleset.extract {
        if !candidate_field_keys.contains(&ext.field) {
            candidate_field_keys.push(ext.field.clone());
        }
    }

    let mut trials_by_field: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for key in &candidate_field_keys {
        trials_by_field.insert(key.clone(), (0, 0));
    }

    for (sample, norm, folded, ts) in &prepared {
        // Evaluate field extraction accuracy on positive samples and any sample carrying field labels
        if !sample.is_match && sample.expected_fields.is_empty() {
            continue;
        }
        let view = folded.as_view(&norm.text_norm);
        let extracted = compiled_initial.run_extractors(norm, &view, *ts);
        for key in &candidate_field_keys {
            let exp_opt = sample.expected_fields.get(key).filter(|v| !v.is_null());
            let act_opt = extracted
                .get(key)
                .map(|ef| &ef.value)
                .filter(|v| !v.is_null());
            match (exp_opt, act_opt) {
                (None, None) => {}
                (Some(exp), Some(act)) => {
                    let entry = trials_by_field.entry(key.clone()).or_insert((0, 0));
                    entry.1 += 1;
                    if values_equivalent(act, exp) {
                        entry.0 += 1;
                    }
                }
                (Some(_), None) | (None, Some(_)) => {
                    let entry = trials_by_field.entry(key.clone()).or_insert((0, 0));
                    entry.1 += 1;
                }
            }
        }
    }

    let mut field_accuracies = BTreeMap::new();
    let mut dropped_set = HashSet::new();
    let mut dropped_fields = Vec::new();

    for key in &candidate_field_keys {
        let &(correct, total) = trials_by_field.get(key).unwrap_or(&(0, 0));
        // If no sample had labels or extractions for a field, keep it if `total == 0`?
        // Per `05-pipeline-rules.md §6.4`: fields with measured accuracy `< 90%` are dropped;
        // if `total == 0` (untested field in holdout), accuracy is `0.0` only if positive samples existed,
        // wait: if `total == 0` because holdout samples didn't include that optional field at all,
        // wait — if an extractor isn't tested at all in holdout we cannot verify >= 90%, UNLESS no
        // field annotations were supplied in any sample! Let's check:
        let any_field_labels_in_dataset = labeled_samples
            .iter()
            .any(|s| !s.expected_fields.is_empty());
        let acc = if total > 0 {
            (correct as f64) / (total as f64)
        } else if any_field_labels_in_dataset {
            0.0
        } else {
            1.0
        };
        field_accuracies.insert(key.clone(), acc);
        if acc + 1e-12 < GATE_MIN_FIELD_ACCURACY {
            dropped_set.insert(key.clone());
            dropped_fields.push(key.clone());
        }
    }

    // 2. Prune extractors below 90% accuracy (`05-pipeline-rules.md §6.4`)
    let mut pruned_ruleset = ruleset.clone();
    if !dropped_set.is_empty() {
        pruned_ruleset
            .extract
            .retain(|ext| !dropped_set.contains(&ext.field));
    }

    let compiled_pruned =
        compile_ruleset_unchecked(&pruned_ruleset).expect("pruned ruleset remains valid");

    // 3. Measure classification gate metrics on the pruned ruleset
    let mut total_positives = 0usize;
    let mut false_negatives = 0usize;
    let mut definite_matches = 0usize;
    let mut true_definite_matches = 0usize;
    let mut self_handled = 0usize;

    for (sample, norm, folded, ts) in &prepared {
        if sample.is_match {
            total_positives += 1;
        }
        let view = folded.as_view(&norm.text_norm);
        let outcome = compiled_pruned.evaluate_with_folded(norm, &view, field_defs, *ts);
        match outcome {
            RulesetOutcome::PrefilterReject | RulesetOutcome::DefiniteNoMatch { .. } => {
                self_handled += 1;
                if sample.is_match {
                    false_negatives += 1;
                }
            }
            RulesetOutcome::DefiniteMatch { .. } => {
                self_handled += 1;
                definite_matches += 1;
                if sample.is_match {
                    true_definite_matches += 1;
                }
            }
            RulesetOutcome::Uncertain { .. } => {}
        }
    }

    let false_negative_rate = if total_positives > 0 {
        (false_negatives as f64) / (total_positives as f64)
    } else {
        0.0
    };

    let accept_precision = if definite_matches > 0 {
        (true_definite_matches as f64) / (definite_matches as f64)
    } else {
        1.0
    };

    let self_handled_rate = (self_handled as f64) / (prepared.len() as f64);

    let passed = false_negative_rate <= GATE_MAX_FALSE_NEGATIVE_RATE + 1e-12
        && accept_precision + 1e-12 >= GATE_MIN_ACCEPT_PRECISION;

    GateReport {
        passed,
        validation_error: None,
        total_samples: prepared.len(),
        false_negative_rate,
        accept_precision,
        self_handled_rate,
        field_accuracies,
        dropped_fields,
        pruned_ruleset,
    }
}
