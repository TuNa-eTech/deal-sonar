//! Ruleset validation, compilation, and performance benchmarking.

use super::*;

pub(super) static BENCHMARK_POST_5000: LazyLock<(NormalizedText, FoldedText)> = LazyLock::new(
    || {
        let paragraph = "Cần thuê căn hộ chung cư 2 phòng ngủ ở khu vực Dịch Vọng, Cầu Giấy, Hà Nội. \
        Gia đình trẻ ở sạch sẽ giữ gìn đồ đạc, tài chính tầm 12 - 15 triệu/tháng, diện tích khoảng \
        65m2 - 75m2, dọn vào đầu tháng sau hoặc ngày 15/11/2026. Liên hệ chính chủ không qua trung gian \
        theo số 0912.345.678. Yêu cầu có ban công thoáng mát, nội thất cơ bản điều hoà nóng lạnh tủ bếp, \
        gần trường học và công viên Cầu Giấy. ";
        let mut buf = String::with_capacity(5_200);
        while buf.chars().count() < 5_000 {
            buf.push_str(paragraph);
        }
        let truncated: String = buf.chars().take(5_000).collect();
        let norm = normalize_text(&truncated);
        let folded = fold_with_spans(&norm.text_norm);
        (norm, folded)
    },
);

/// Validate a [`RulesetBody`] (`05-pipeline-rules.md §6.4`):
/// 1. Checks DSL version, thresholds, unique rule IDs, field identifiers, and nesting depth.
/// 2. Compiles every regex with linear-time NFA/DFA size limits and nested-quantifier guards.
/// 3. Benchmarks execution on a 5,000-character Vietnamese post and verifies median latency `< 1ms`
///    (retrying once across 5 runs to tolerate OS scheduling jitter in shared CI).
pub fn validate_ruleset(ruleset: &RulesetBody) -> Result<CompiledRuleset, RulesetValidationError> {
    let compiled = compile_ruleset_unchecked(ruleset)?;

    let (bench_norm, bench_folded) = &*BENCHMARK_POST_5000;
    let bench_view = bench_folded.as_view(&bench_norm.text_norm);
    let ref_ts_ms = 1_794_384_000_000_i64;

    // Warmup pass
    let _ = compiled.evaluate_with_folded(bench_norm, &bench_view, &[], ref_ts_ms);

    let mut median = measure_median_5(&compiled, bench_norm, &bench_view, ref_ts_ms);
    for _ in 0..3 {
        if median < MAX_RULESET_EXEC_DURATION {
            break;
        }
        // Retry if the thread experienced transient OS CPU preemption during parallel CI test runs
        let retry_median = measure_median_5(&compiled, bench_norm, &bench_view, ref_ts_ms);
        median = median.min(retry_median);
    }

    if median >= MAX_RULESET_EXEC_DURATION {
        return Err(RulesetValidationError::TooSlow {
            median_us: median.as_micros(),
        });
    }

    Ok(compiled)
}

pub(super) fn measure_median_5(
    compiled: &CompiledRuleset,
    norm: &NormalizedText,
    folded: &FoldedView<'_>,
    ref_ts_ms: i64,
) -> Duration {
    let mut samples = [Duration::ZERO; 5];
    for slot in &mut samples {
        let t0 = Instant::now();
        // Run both extraction and classification unconditionally in the benchmark so a slow rule/extractor
        // cannot hide behind an early `prefilter` short-circuit!
        let _ = std::hint::black_box(compiled.benchmark_full_pass(norm, folded, ref_ts_ms));
        *slot = t0.elapsed();
    }
    samples.sort_unstable();
    samples[2]
}

/// Compile a [`RulesetBody`] checking all schema & regex invariants (without running the benchmark).
pub fn compile_ruleset_unchecked(
    ruleset: &RulesetBody,
) -> Result<CompiledRuleset, RulesetValidationError> {
    if ruleset.dsl != SUPPORTED_DSL_VERSION {
        return Err(RulesetValidationError::UnsupportedDslVersion(ruleset.dsl));
    }
    if !ruleset.thresholds.accept.is_finite()
        || ruleset.thresholds.accept <= 0.0
        || ruleset.thresholds.accept > 1.0
        || !ruleset.thresholds.reject.is_finite()
        || ruleset.thresholds.reject <= 0.0
        || ruleset.thresholds.reject > 1.0
    {
        return Err(RulesetValidationError::InvalidThresholds {
            accept: ruleset.thresholds.accept,
            reject: ruleset.thresholds.reject,
        });
    }

    let prefilter = match &ruleset.prefilter {
        Some(pf) => Some(compile_prefilter(pf)?),
        None => None,
    };

    let mut seen_ids = HashSet::with_capacity(ruleset.classify.len());
    let mut classify = Vec::with_capacity(ruleset.classify.len());
    for rule in &ruleset.classify {
        let id = rule.id.trim();
        if id.is_empty() {
            return Err(RulesetValidationError::EmptyRuleId);
        }
        if !seen_ids.insert(id.to_string()) {
            return Err(RulesetValidationError::DuplicateRuleId(id.to_string()));
        }
        if !rule.confidence.is_finite() || !(0.0..=1.0).contains(&rule.confidence) {
            return Err(RulesetValidationError::InvalidConfidence {
                rule_id: id.to_string(),
                confidence: rule.confidence,
            });
        }
        let when = compile_condition(&rule.when, 0, id)?;
        classify.push(CompiledClassifyRule {
            id: id.to_string(),
            when,
            verdict: rule.verdict,
            confidence: rule.confidence,
            set: rule.set.clone(),
        });
    }

    let mut extract = Vec::with_capacity(ruleset.extract.len());
    for ext in &ruleset.extract {
        if !is_valid_field_key(&ext.field) {
            return Err(RulesetValidationError::InvalidFieldKey(ext.field.clone()));
        }
        let compiled_ext = compile_extractor(&ext.field, &ext.config)?;
        extract.push(CompiledExtractRule {
            field: ext.field.clone(),
            extractor: compiled_ext,
        });
    }

    Ok(CompiledRuleset {
        prefilter,
        classify,
        extract,
        thresholds: ruleset.thresholds.clone(),
    })
}

pub(super) fn is_valid_field_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
}

pub(super) fn compile_pattern_item(
    raw: &str,
    context: &str,
) -> Result<CompiledPatternItem, RulesetValidationError> {
    if let Some(re_pat) = raw.strip_prefix("re:") {
        let re = compile_safe_regex(re_pat).map_err(|source| RulesetValidationError::Regex {
            context: context.to_string(),
            source,
        })?;
        Ok(CompiledPatternItem::Regex(re))
    } else {
        let folded = fold_text(raw);
        if folded.is_empty() {
            return Err(RulesetValidationError::EmptyConditionList("keyword"));
        }
        Ok(CompiledPatternItem::Keyword(folded))
    }
}

pub(super) fn compile_prefilter(
    pf: &PrefilterSpec,
) -> Result<CompiledPrefilter, RulesetValidationError> {
    let mut any = Vec::with_capacity(pf.any.len());
    for item in &pf.any {
        any.push(compile_pattern_item(item, "prefilter.any")?);
    }
    let mut none = Vec::with_capacity(pf.none.len());
    for item in &pf.none {
        none.push(compile_pattern_item(item, "prefilter.none")?);
    }
    Ok(CompiledPrefilter {
        any: CompiledPatternList::from_items(any),
        none: CompiledPatternList::from_items(none),
        min_len: pf.min_len,
    })
}

pub(super) fn compile_condition(
    cond: &Condition,
    depth: usize,
    rule_id: &str,
) -> Result<CompiledCondition, RulesetValidationError> {
    if depth > MAX_CONDITION_DEPTH {
        return Err(RulesetValidationError::ConditionTooDeep);
    }
    match cond {
        Condition::All(items) => {
            if items.is_empty() {
                return Err(RulesetValidationError::EmptyConditionList("all"));
            }
            let mut out = Vec::with_capacity(items.len());
            for c in items {
                out.push(compile_condition(c, depth + 1, rule_id)?);
            }
            // Evaluate O(1) metadata/field predicates (`HasField`, `FieldCmp`, `LenLt`, `LenGt`, `LangIn`)
            // before full-text `KwAny` / `KwNone` / `Re` scans so conjunctions short-circuit immediately.
            out.sort_by_key(condition_eval_cost);
            Ok(CompiledCondition::All(out))
        }
        Condition::Any(items) => {
            if items.is_empty() {
                return Err(RulesetValidationError::EmptyConditionList("any"));
            }
            let mut out = Vec::with_capacity(items.len());
            for c in items {
                out.push(compile_condition(c, depth + 1, rule_id)?);
            }
            out.sort_by_key(condition_eval_cost);
            Ok(CompiledCondition::Any(out))
        }
        Condition::Not(inner) => Ok(CompiledCondition::Not(Box::new(compile_condition(
            inner,
            depth + 1,
            rule_id,
        )?))),
        Condition::KwAny(kws) => {
            if kws.is_empty() {
                return Err(RulesetValidationError::EmptyConditionList("kw_any"));
            }
            let mut out = Vec::with_capacity(kws.len());
            for kw in kws {
                out.push(compile_pattern_item(
                    kw,
                    &format!("rule `{rule_id}` kw_any"),
                )?);
            }
            Ok(CompiledCondition::KwAny(CompiledPatternList::from_items(
                out,
            )))
        }
        Condition::KwNone(kws) => {
            if kws.is_empty() {
                return Err(RulesetValidationError::EmptyConditionList("kw_none"));
            }
            let mut out = Vec::with_capacity(kws.len());
            for kw in kws {
                out.push(compile_pattern_item(
                    kw,
                    &format!("rule `{rule_id}` kw_none"),
                )?);
            }
            Ok(CompiledCondition::KwNone(CompiledPatternList::from_items(
                out,
            )))
        }
        Condition::Re(pat) => {
            let re = compile_safe_regex(pat).map_err(|source| RulesetValidationError::Regex {
                context: format!("rule `{rule_id}` re"),
                source,
            })?;
            Ok(CompiledCondition::Re(re))
        }
        Condition::HasField(f) => {
            if !is_valid_field_key(f) {
                return Err(RulesetValidationError::InvalidFieldKey(f.clone()));
            }
            Ok(CompiledCondition::HasField(f.clone()))
        }
        Condition::LenLt(n) => Ok(CompiledCondition::LenLt(*n)),
        Condition::LenGt(n) => Ok(CompiledCondition::LenGt(*n)),
        Condition::LangIn(langs) => {
            if langs.is_empty() {
                return Err(RulesetValidationError::EmptyConditionList("lang_in"));
            }
            let norm_langs = langs
                .iter()
                .map(|l| canonical_lang_code(l).to_string())
                .collect();
            Ok(CompiledCondition::LangIn(norm_langs))
        }
        Condition::FieldCmp(cmp) => {
            if !is_valid_field_key(&cmp.field) {
                return Err(RulesetValidationError::InvalidFieldKey(cmp.field.clone()));
            }
            Ok(CompiledCondition::FieldCmp(cmp.clone()))
        }
    }
}

pub(super) fn condition_eval_cost(cond: &CompiledCondition) -> u8 {
    match cond {
        CompiledCondition::HasField(_)
        | CompiledCondition::LenLt(_)
        | CompiledCondition::LenGt(_)
        | CompiledCondition::LangIn(_)
        | CompiledCondition::FieldCmp(_) => 0,
        CompiledCondition::Not(inner) => condition_eval_cost(inner).saturating_add(1),
        CompiledCondition::All(items) | CompiledCondition::Any(items) => items
            .iter()
            .map(condition_eval_cost)
            .max()
            .unwrap_or(1)
            .max(1),
        CompiledCondition::KwAny(_) | CompiledCondition::KwNone(_) | CompiledCondition::Re(_) => 3,
    }
}

pub(super) fn compile_extractor(
    field: &str,
    cfg: &ExtractorConfig,
) -> Result<CompiledExtractor, RulesetValidationError> {
    match cfg {
        ExtractorConfig::VnMoney { near, window } => Ok(CompiledExtractor::VnMoney {
            near_folded: near
                .iter()
                .map(|s| fold_text(s))
                .filter(|s| !s.is_empty())
                .collect(),
            window: *window,
        }),
        ExtractorConfig::VnPhone => Ok(CompiledExtractor::VnPhone),
        ExtractorConfig::VnArea => Ok(CompiledExtractor::VnArea),
        ExtractorConfig::Gazetteer { dict, scope } => {
            if dict != "vn_admin" {
                return Err(RulesetValidationError::UnsupportedGazetteerDict(
                    dict.clone(),
                ));
            }
            Ok(CompiledExtractor::Gazetteer {
                scope: scope.clone(),
            })
        }
        ExtractorConfig::Number {
            units,
            prefixes,
            multipliers,
        } => Ok(CompiledExtractor::Number(NumberExtractorConfig {
            units: units.clone(),
            prefixes: prefixes.clone(),
            multipliers: multipliers.clone(),
        })),
        ExtractorConfig::DateVi => Ok(CompiledExtractor::DateVi),
        ExtractorConfig::EnumKw { map, multi } => {
            if map.is_empty() || map.values().any(|kws| kws.is_empty()) {
                return Err(RulesetValidationError::EmptyEnumMap(field.to_string()));
            }
            Ok(CompiledExtractor::EnumKw {
                patterns: Box::new(compile_enum_patterns(map)),
                multi: *multi,
            })
        }
        ExtractorConfig::Regex {
            pattern,
            group,
            cast,
        } => {
            let regex =
                compile_safe_regex(pattern).map_err(|source| RulesetValidationError::Regex {
                    context: format!("extract `{field}`"),
                    source,
                })?;
            let max_group = regex.captures_len().saturating_sub(1);
            if *group > max_group {
                return Err(RulesetValidationError::Regex {
                    context: format!("extract `{field}`"),
                    source: RegexSafetyError::InvalidCaptureGroup {
                        group: *group,
                        max_group,
                    },
                });
            }
            Ok(CompiledExtractor::Regex {
                regex,
                group: *group,
                cast: *cast,
            })
        }
    }
}
