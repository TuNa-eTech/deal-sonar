//! Human-readable ruleset descriptions and keyword collection.

use super::*;

/// Extract a human-readable summary of accept keywords, reject keywords, and extracted field keys
/// for the Radar Ruleset Inspector UI (`05-pipeline-rules.md §6.5`).
pub fn describe_ruleset(ruleset: &RulesetBody) -> RulesetSummary {
    let mut accept_keywords = Vec::new();
    let mut reject_keywords = Vec::new();

    if let Some(pf) = &ruleset.prefilter {
        for kw in &pf.any {
            push_unique(&mut accept_keywords, kw);
        }
        for kw in &pf.none {
            push_unique(&mut reject_keywords, kw);
        }
    }

    for rule in &ruleset.classify {
        collect_condition_keywords(
            &rule.when,
            rule.verdict == RuleVerdict::Match,
            &mut accept_keywords,
            &mut reject_keywords,
        );
    }

    let mut extracted_fields = Vec::new();
    for ext in &ruleset.extract {
        push_unique(&mut extracted_fields, &ext.field);
    }

    RulesetSummary {
        accept_keywords,
        reject_keywords,
        extracted_fields,
    }
}

pub(super) fn collect_condition_keywords(
    cond: &Condition,
    positive_branch: bool,
    accept: &mut Vec<String>,
    reject: &mut Vec<String>,
) {
    match cond {
        Condition::All(items) | Condition::Any(items) => {
            for item in items {
                collect_condition_keywords(item, positive_branch, accept, reject);
            }
        }
        Condition::Not(inner) => {
            collect_condition_keywords(inner, !positive_branch, accept, reject);
        }
        Condition::KwAny(kws) => {
            let dest = if positive_branch { accept } else { reject };
            for kw in kws {
                push_unique(dest, kw);
            }
        }
        Condition::KwNone(kws) => {
            let dest = if positive_branch { reject } else { accept };
            for kw in kws {
                push_unique(dest, kw);
            }
        }
        _ => {}
    }
}

pub(super) fn push_unique(vec: &mut Vec<String>, item: &str) {
    if !vec.iter().any(|existing| existing == item) {
        vec.push(item.to_string());
    }
}
