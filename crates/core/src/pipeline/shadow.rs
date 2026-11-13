//! Shadow ruleset tracking and audit sampling.

use super::*;

/// Deterministic 5% audit sampler based on SHA-256 / FNV byte mix of `post_id`.
pub fn should_sample_for_audit(post_id: &str, percent: u8) -> bool {
    if percent == 0 {
        return false;
    }
    if percent >= 100 {
        return true;
    }
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in post_id.as_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    (hash % 100) < u64::from(percent)
}

/// Record a shadow ruleset's T4 prediction so it can be compared against T5 AI truth.
pub(super) fn record_shadow_prediction(
    rt: &CoreRuntime,
    shadow_ruleset_id: &str,
    post_id: &str,
    outcome: &RulesetOutcome,
) -> CoreResult<()> {
    let key = format!("runtime.shadow.{shadow_ruleset_id}");
    let mut tracker: ShadowTrackerState = rt.store.get_setting(&key)?.unwrap_or_default();
    let pred = match outcome {
        RulesetOutcome::DefiniteMatch { .. } => "match",
        RulesetOutcome::PrefilterReject | RulesetOutcome::DefiniteNoMatch { .. } => "no_match",
        RulesetOutcome::Uncertain { .. } => "uncertain",
    };
    if tracker.pending_predictions.len() >= 1_000 {
        tracker.pending_predictions.clear();
    }
    tracker
        .pending_predictions
        .insert(post_id.to_string(), pred.to_string());
    rt.store.set_setting(&key, &tracker)?;
    Ok(())
}

/// Compare shadow ruleset's prediction against AI's ground-truth verdict and promote `shadow -> active`
/// once thresholds (`>= shadow_min_posts` OR `>= shadow_min_age_ms`) are satisfied (`05-pipeline-rules.md §6.4`).
pub fn reconcile_shadow_with_ai_truth(
    rt: &CoreRuntime,
    shadow_rec: &dealsonar_store::models::RulesetRecord,
    post_id: &str,
    ai_is_match: bool,
    now: i64,
) -> CoreResult<bool> {
    let key = format!("runtime.shadow.{}", shadow_rec.id);
    let mut tracker: ShadowTrackerState = rt.store.get_setting(&key)?.unwrap_or_default();
    let Some(pred) = tracker.pending_predictions.remove(post_id) else {
        return Ok(false);
    };

    tracker.total_evaluated += 1;
    if pred != "uncertain" {
        tracker.rule_self_handled += 1;
    }
    if pred == "match" {
        tracker.definite_match_total += 1;
        if ai_is_match {
            tracker.definite_match_correct += 1;
        }
    }
    if ai_is_match {
        tracker.positive_truth_total += 1;
        if pred == "no_match" {
            tracker.positive_falsely_rejected += 1;
        }
    }

    let rule_pct = if tracker.total_evaluated > 0 {
        ((tracker.rule_self_handled as f64 / tracker.total_evaluated as f64) * 100.0).round()
    } else {
        0.0
    };
    let accept_precision = if tracker.definite_match_total > 0 {
        tracker.definite_match_correct as f64 / tracker.definite_match_total as f64
    } else {
        1.0
    };
    let false_negative_rate = if tracker.positive_truth_total > 0 {
        tracker.positive_falsely_rejected as f64 / tracker.positive_truth_total as f64
    } else {
        0.0
    };

    let metrics = RulesetMetrics {
        rule_handled_pct: rule_pct,
        ai_handled_pct: (100.0 - rule_pct).max(0.0),
        accept_precision,
        false_negative_rate,
        sample_size: tracker.total_evaluated,
    };
    let metrics_val = serde_json::to_value(&metrics)?;
    rt.store.set_setting(&key, &tracker)?;

    let ready_by_count = tracker.total_evaluated >= rt.config.shadow_min_posts;
    let ready_by_age = tracker.total_evaluated >= 10
        && now.saturating_sub(shadow_rec.created_at) >= rt.config.shadow_min_age_ms;

    if ready_by_count || ready_by_age {
        if accept_precision >= dealsonar_rules::GATE_MIN_ACCEPT_PRECISION
            && false_negative_rate <= dealsonar_rules::GATE_MAX_FALSE_NEGATIVE_RATE
        {
            rt.store
                .update_ruleset_state(&shadow_rec.id, "active", Some(&metrics_val), now)?;
            return Ok(true);
        } else if ready_by_count {
            // Failed shadow promotion gate -> retire
            rt.store
                .update_ruleset_state(&shadow_rec.id, "retired", Some(&metrics_val), now)?;
            return Ok(false);
        }
    }

    rt.store
        .update_ruleset_state(&shadow_rec.id, "shadow", Some(&metrics_val), now)?;
    Ok(false)
}

pub(super) fn enqueue_audit_sample(
    rt: &CoreRuntime,
    radar_version_id: &str,
    ruleset_id: &str,
    evaluation_id: &str,
    now: i64,
) -> CoreResult<()> {
    let key = format!("runtime.audit_queue.{ruleset_id}");
    let mut queue: Vec<String> = rt.store.get_setting(&key)?.unwrap_or_default();
    if queue.len() < 30 && !queue.iter().any(|id| id == evaluation_id) {
        queue.push(evaluation_id.to_string());
        rt.store.set_setting(&key, &queue)?;
    }

    let dedup = format!("audit_ruleset:{ruleset_id}");
    let _ = rt.store.enqueue_job(
        "audit_ruleset",
        Some(&dedup),
        &json!({
            "radar_version_id": radar_version_id,
            "ruleset_id": ruleset_id,
        }),
        now.saturating_add(60_000),
        now,
    )?;
    Ok(())
}
