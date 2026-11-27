//! Cross-crate converters between DTO rulesets and `dealsonar_rules` rulesets.

use super::*;

/// Convert canonical [`dealsonar_rules::RulesetBody`] into UI [`RulesetBody`] (`ipc.ts`).
pub fn rules_to_dto_ruleset_body(body: &dealsonar_rules::RulesetBody) -> RulesetBody {
    let prefilter = match &body.prefilter {
        Some(pf) => RulesetPrefilter {
            any: pf.any.clone(),
            none: pf.none.clone(),
            min_len: pf.min_len,
        },
        None => RulesetPrefilter::default(),
    };

    let classify = body
        .classify
        .iter()
        .map(|rule| {
            let mut kw_any_acc = Vec::new();
            let mut kw_none_acc = Vec::new();
            let mut has_field_acc = None;
            extract_flat_condition_hints(
                &rule.when,
                &mut kw_any_acc,
                &mut kw_none_acc,
                &mut has_field_acc,
            );
            RulesetClassifyRule {
                id: rule.id.clone(),
                description: None,
                kw_any: (!kw_any_acc.is_empty()).then_some(kw_any_acc),
                kw_none: (!kw_none_acc.is_empty()).then_some(kw_none_acc),
                has_field: has_field_acc,
                when: Some(rule.when.clone()),
                verdict: match rule.verdict {
                    dealsonar_rules::RuleVerdict::Match => "match".to_string(),
                    dealsonar_rules::RuleVerdict::NoMatch => "no_match".to_string(),
                },
                confidence: rule.confidence,
                set: (!rule.set.is_empty()).then(|| rule.set.clone()),
            }
        })
        .collect();

    let extract = body
        .extract
        .iter()
        .map(|er| match &er.config {
            dealsonar_rules::ExtractorConfig::VnMoney { near, window } => RulesetExtractorRule {
                field: er.field.clone(),
                extractor: "vn_money".to_string(),
                near: (!near.is_empty()).then(|| near.clone()),
                window: Some(*window),
                ..Default::default()
            },
            dealsonar_rules::ExtractorConfig::VnPhone => RulesetExtractorRule {
                field: er.field.clone(),
                extractor: "vn_phone".to_string(),
                ..Default::default()
            },
            dealsonar_rules::ExtractorConfig::VnArea => RulesetExtractorRule {
                field: er.field.clone(),
                extractor: "vn_area".to_string(),
                ..Default::default()
            },
            dealsonar_rules::ExtractorConfig::Gazetteer { dict, scope } => RulesetExtractorRule {
                field: er.field.clone(),
                extractor: "gazetteer".to_string(),
                dict: Some(dict.clone()),
                scope: scope.clone(),
                ..Default::default()
            },
            dealsonar_rules::ExtractorConfig::Number {
                units,
                prefixes,
                multipliers,
            } => RulesetExtractorRule {
                field: er.field.clone(),
                extractor: "number".to_string(),
                units: Some(units.clone()),
                prefixes: Some(prefixes.clone()),
                multipliers: Some(multipliers.clone()),
                ..Default::default()
            },
            dealsonar_rules::ExtractorConfig::DateVi => RulesetExtractorRule {
                field: er.field.clone(),
                extractor: "date_vi".to_string(),
                ..Default::default()
            },
            dealsonar_rules::ExtractorConfig::EnumKw { map, multi } => RulesetExtractorRule {
                field: er.field.clone(),
                extractor: "enum_kw".to_string(),
                map: Some(map.clone()),
                multi: Some(*multi),
                ..Default::default()
            },
            dealsonar_rules::ExtractorConfig::Regex {
                pattern,
                group,
                cast,
            } => RulesetExtractorRule {
                field: er.field.clone(),
                extractor: "regex".to_string(),
                pattern: Some(pattern.clone()),
                group: Some(*group),
                cast: Some(*cast),
                ..Default::default()
            },
        })
        .collect();

    RulesetBody {
        dsl: body.dsl,
        prefilter,
        classify,
        extract,
        thresholds: RulesetThresholds {
            accept: body.thresholds.accept,
            reject: body.thresholds.reject,
        },
    }
}

pub(super) fn extract_flat_condition_hints(
    cond: &dealsonar_rules::Condition,
    kw_any: &mut Vec<String>,
    kw_none: &mut Vec<String>,
    has_field: &mut Option<String>,
) {
    match cond {
        dealsonar_rules::Condition::KwAny(kws) => {
            for kw in kws {
                if !kw_any.contains(kw) {
                    kw_any.push(kw.clone());
                }
            }
        }
        dealsonar_rules::Condition::KwNone(kws) => {
            for kw in kws {
                if !kw_none.contains(kw) {
                    kw_none.push(kw.clone());
                }
            }
        }
        dealsonar_rules::Condition::HasField(f) => {
            if has_field.is_none() {
                *has_field = Some(f.clone());
            }
        }
        dealsonar_rules::Condition::All(children) => {
            for c in children {
                extract_flat_condition_hints(c, kw_any, kw_none, has_field);
            }
        }
        _ => {}
    }
}

/// Convert UI [`RulesetBody`] (or full DSL JSON) into canonical [`dealsonar_rules::RulesetBody`].
pub fn dto_ruleset_body_to_rules(dto: &RulesetBody) -> dealsonar_rules::RulesetBody {
    let prefilter = if dto.prefilter.any.is_empty()
        && dto.prefilter.none.is_empty()
        && dto.prefilter.min_len.is_none()
    {
        None
    } else {
        Some(dealsonar_rules::PrefilterSpec {
            any: dto.prefilter.any.clone(),
            none: dto.prefilter.none.clone(),
            min_len: dto.prefilter.min_len,
        })
    };

    let classify = dto
        .classify
        .iter()
        .map(|r| {
            let cur_any = r.kw_any.as_ref().filter(|v| !v.is_empty()).cloned();
            let cur_none = r.kw_none.as_ref().filter(|v| !v.is_empty()).cloned();
            let cur_hf = r
                .has_field
                .as_ref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());

            // Preserve `existing_when` whenever `r.when` is present and the flat hint fields
            // (`kw_any`, `kw_none`, `has_field`) were not modified relative to `existing_when`
            // (so `ruleset_list -> ruleset_save_user` roundtrips never clobber `FieldOp`, `Any`,
            // `Not`, `LenGt`, `Regex`, or multi-`HasField` trees!).
            let preserve_existing = if let Some(existing_when) = &r.when {
                let mut orig_any_vec = Vec::new();
                let mut orig_none_vec = Vec::new();
                let mut orig_hf = None;
                extract_flat_condition_hints(
                    existing_when,
                    &mut orig_any_vec,
                    &mut orig_none_vec,
                    &mut orig_hf,
                );
                let orig_any = (!orig_any_vec.is_empty()).then_some(orig_any_vec);
                let orig_none = (!orig_none_vec.is_empty()).then_some(orig_none_vec);
                let orig_hf_clean = orig_hf
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
                (cur_any == orig_any && cur_none == orig_none && cur_hf == orig_hf_clean)
                    || (cur_any.is_none() && cur_none.is_none() && cur_hf.is_none())
            } else {
                false
            };

            let when = if preserve_existing {
                r.when.clone().expect("checked Some")
            } else {
                let mut clauses = Vec::new();
                if let Some(any_kws) = cur_any {
                    clauses.push(dealsonar_rules::Condition::KwAny(any_kws));
                }
                if let Some(none_kws) = cur_none {
                    clauses.push(dealsonar_rules::Condition::KwNone(none_kws));
                }
                if let Some(hf) = cur_hf {
                    clauses.push(dealsonar_rules::Condition::HasField(hf));
                }
                if clauses.is_empty() {
                    r.when
                        .clone()
                        .unwrap_or(dealsonar_rules::Condition::LenGt(0))
                } else if clauses.len() == 1 {
                    clauses.remove(0)
                } else {
                    dealsonar_rules::Condition::All(clauses)
                }
            };

            dealsonar_rules::ClassifyRule {
                id: r.id.clone(),
                when,
                verdict: if r.verdict == "no_match" {
                    dealsonar_rules::RuleVerdict::NoMatch
                } else {
                    dealsonar_rules::RuleVerdict::Match
                },
                confidence: r.confidence,
                set: r.set.clone().unwrap_or_default(),
            }
        })
        .collect();

    let extract = dto
        .extract
        .iter()
        .map(|er| {
            let config = match er.extractor.as_str() {
                "vn_money" => dealsonar_rules::ExtractorConfig::VnMoney {
                    near: er.near.clone().unwrap_or_default(),
                    window: er.window.unwrap_or(dealsonar_rules::DEFAULT_MONEY_WINDOW),
                },
                "vn_phone" => dealsonar_rules::ExtractorConfig::VnPhone,
                "vn_area" => dealsonar_rules::ExtractorConfig::VnArea,
                "gazetteer" => dealsonar_rules::ExtractorConfig::Gazetteer {
                    dict: er.dict.clone().unwrap_or_else(|| "vn_admin".to_string()),
                    scope: er.scope.clone(),
                },
                "number" => dealsonar_rules::ExtractorConfig::Number {
                    units: er.units.clone().unwrap_or_default(),
                    prefixes: er.prefixes.clone().unwrap_or_default(),
                    multipliers: er.multipliers.clone().unwrap_or_default(),
                },
                "date_vi" => dealsonar_rules::ExtractorConfig::DateVi,
                "enum_kw" => dealsonar_rules::ExtractorConfig::EnumKw {
                    map: er.map.clone().unwrap_or_default(),
                    multi: er.multi.unwrap_or(false),
                },
                "regex" => dealsonar_rules::ExtractorConfig::Regex {
                    pattern: er.pattern.clone().unwrap_or_default(),
                    group: er.group.unwrap_or(0),
                    cast: er.cast.unwrap_or_default(),
                },
                _ => dealsonar_rules::ExtractorConfig::VnPhone,
            };
            dealsonar_rules::ExtractRule {
                field: er.field.clone(),
                config,
            }
        })
        .collect();

    dealsonar_rules::RulesetBody {
        dsl: dto.dsl,
        prefilter,
        classify,
        extract,
        thresholds: dealsonar_rules::Thresholds {
            accept: dto.thresholds.accept,
            reject: dto.thresholds.reject,
        },
    }
}

pub fn ruleset_record_to_dto(rec: &dealsonar_store::models::RulesetRecord) -> Ruleset {
    let dto_body = if let Ok(engine_body) =
        serde_json::from_value::<dealsonar_rules::RulesetBody>(rec.body.clone())
    {
        rules_to_dto_ruleset_body(&engine_body)
    } else {
        serde_json::from_value::<RulesetBody>(rec.body.clone()).unwrap_or(RulesetBody {
            dsl: 1,
            prefilter: RulesetPrefilter::default(),
            classify: Vec::new(),
            extract: Vec::new(),
            thresholds: RulesetThresholds::default(),
        })
    };

    let metrics = rec
        .metrics
        .as_ref()
        .and_then(|v| serde_json::from_value::<RulesetMetrics>(v.clone()).ok());

    Ruleset {
        id: rec.id.clone(),
        radar_version_id: rec.radar_version_id.clone(),
        revision: rec.revision,
        state: rec.state.clone(),
        origin: rec.origin.clone(),
        body: dto_body,
        metrics,
        created_at: rec.created_at,
        activated_at: rec.activated_at,
    }
}
