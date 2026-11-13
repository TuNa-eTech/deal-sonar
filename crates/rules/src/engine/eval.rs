//! Compiled ruleset evaluation (prefilter, conditions, extractors, classification).

use super::*;

impl CompiledRuleset {
    /// Evaluate this compiled ruleset against a normalized post (`05-pipeline-rules.md §6.2`).
    pub fn evaluate(
        &self,
        post: &NormalizedText,
        field_defs: &[FieldDef],
        ref_ts_ms: i64,
    ) -> RulesetOutcome {
        let view = FoldedView::lazy(&post.text_norm, &post.text_fold);
        self.evaluate_with_folded(post, &view, field_defs, ref_ts_ms)
    }

    pub(crate) fn evaluate_with_folded(
        &self,
        post: &NormalizedText,
        folded: &FoldedView<'_>,
        field_defs: &[FieldDef],
        ref_ts_ms: i64,
    ) -> RulesetOutcome {
        let char_len_cache = std::cell::OnceCell::new();
        if let Some(pf) = &self.prefilter {
            if !eval_prefilter(pf, &post.text_norm, folded, &char_len_cache) {
                return RulesetOutcome::PrefilterReject;
            }
        }

        let extracted = self.run_extractors(post, folded, ref_ts_ms);
        self.classify_extracted(post, folded, &char_len_cache, field_defs, extracted)
    }

    /// Runs prefilter, all extractors, and all classify rules without short-circuiting prefilter
    /// so `validate_ruleset` measures full worst-case ruleset latency.
    pub(super) fn benchmark_full_pass(
        &self,
        post: &NormalizedText,
        folded: &FoldedView<'_>,
        ref_ts_ms: i64,
    ) -> usize {
        let char_len_cache = std::cell::OnceCell::new();
        let pf_ok = self
            .prefilter
            .as_ref()
            .map(|pf| eval_prefilter(pf, &post.text_norm, folded, &char_len_cache))
            .unwrap_or(true);
        let extracted = self.run_extractors(post, folded, ref_ts_ms);
        for rule in &self.classify {
            let _ = eval_condition(&rule.when, post, folded, &char_len_cache, &extracted);
        }
        usize::from(pf_ok) + extracted.len()
    }

    pub(crate) fn run_extractors(
        &self,
        post: &NormalizedText,
        folded: &FoldedView<'_>,
        ref_ts_ms: i64,
    ) -> ExtractedFields {
        let mut out = ExtractedFields::new();
        for item in &self.extract {
            if out.contains_key(&item.field) {
                continue;
            }
            let first_match = match &item.extractor {
                CompiledExtractor::VnMoney {
                    near_folded,
                    window,
                } => extract_vn_money_from_folded(
                    &post.text_norm,
                    folded,
                    near_folded,
                    Some(*window),
                    true,
                )
                .into_iter()
                .next(),
                CompiledExtractor::VnPhone => extract_vn_phone_first(&post.text_norm),
                CompiledExtractor::VnArea => {
                    extract_vn_area_from_folded(&post.text_norm, folded, true)
                        .into_iter()
                        .next()
                }
                CompiledExtractor::Gazetteer { scope } => {
                    extract_gazetteer_from_folded(&post.text_norm, folded, scope.as_deref(), true)
                        .into_iter()
                        .next()
                }
                CompiledExtractor::Number(cfg) => {
                    extract_number_from_folded(&post.text_norm, folded, cfg)
                        .into_iter()
                        .next()
                }
                CompiledExtractor::DateVi => {
                    extract_date_vi_from_folded(&post.text_norm, folded, ref_ts_ms)
                        .into_iter()
                        .next()
                }
                CompiledExtractor::EnumKw { patterns, multi } => {
                    extract_enum_kw_compiled(&post.text_norm, folded, patterns, *multi, true)
                        .into_iter()
                        .next()
                }
                CompiledExtractor::Regex { regex, group, cast } => {
                    extract_compiled_regex_first(&post.text_norm, folded, regex, *group, *cast)
                }
            };
            if let Some(first) = first_match {
                out.insert(
                    item.field.clone(),
                    first.into_extracted_field(FieldSource::Rule),
                );
            }
        }
        out
    }

    pub(super) fn classify_extracted(
        &self,
        post: &NormalizedText,
        folded: &FoldedView<'_>,
        char_len_cache: &std::cell::OnceCell<usize>,
        field_defs: &[FieldDef],
        extracted: ExtractedFields,
    ) -> RulesetOutcome {
        for rule in &self.classify {
            if eval_condition(&rule.when, post, folded, char_len_cache, &extracted) {
                match rule.verdict {
                    RuleVerdict::Match => {
                        let all_required_present = field_defs
                            .iter()
                            .filter(|d| d.required)
                            .all(|d| extracted.contains_key(&d.key));
                        if rule.confidence >= self.thresholds.accept && all_required_present {
                            return RulesetOutcome::DefiniteMatch {
                                rule_id: rule.id.clone(),
                                confidence: rule.confidence,
                                fields: extracted,
                                set: rule.set.clone(),
                            };
                        }
                        return RulesetOutcome::Uncertain {
                            hint_fields: extracted,
                            matched_rule_id: Some(rule.id.clone()),
                            verdict: Some(RuleVerdict::Match),
                            confidence: Some(rule.confidence),
                            set: rule.set.clone(),
                        };
                    }
                    RuleVerdict::NoMatch => {
                        if rule.confidence >= self.thresholds.reject {
                            return RulesetOutcome::DefiniteNoMatch {
                                rule_id: rule.id.clone(),
                                confidence: rule.confidence,
                                set: rule.set.clone(),
                            };
                        }
                        return RulesetOutcome::Uncertain {
                            hint_fields: extracted,
                            matched_rule_id: Some(rule.id.clone()),
                            verdict: Some(RuleVerdict::NoMatch),
                            confidence: Some(rule.confidence),
                            set: rule.set.clone(),
                        };
                    }
                }
            }
        }

        RulesetOutcome::Uncertain {
            hint_fields: extracted,
            matched_rule_id: None,
            verdict: None,
            confidence: None,
            set: BTreeMap::new(),
        }
    }
}

#[inline]
pub(super) fn get_char_len(text_norm: &str, cache: &std::cell::OnceCell<usize>) -> usize {
    *cache.get_or_init(|| {
        text_norm
            .as_bytes()
            .iter()
            .filter(|&&b| (b as i8) >= -64)
            .count()
    })
}

pub(super) fn eval_prefilter(
    pf: &CompiledPrefilter,
    text_norm: &str,
    folded: &FoldedView<'_>,
    char_len_cache: &std::cell::OnceCell<usize>,
) -> bool {
    if let Some(min_len) = pf.min_len {
        if text_norm.len() < min_len {
            return false;
        }
        if text_norm.len() < min_len.saturating_mul(4)
            && get_char_len(text_norm, char_len_cache) < min_len
        {
            return false;
        }
    }
    if !pf.any.is_empty() && !pf.any.matches_any(folded) {
        return false;
    }
    if pf.none.matches_any(folded) {
        return false;
    }
    true
}

pub(super) fn eval_condition(
    cond: &CompiledCondition,
    post: &NormalizedText,
    folded: &FoldedView<'_>,
    char_len_cache: &std::cell::OnceCell<usize>,
    extracted: &ExtractedFields,
) -> bool {
    match cond {
        CompiledCondition::All(items) => items
            .iter()
            .all(|c| eval_condition(c, post, folded, char_len_cache, extracted)),
        CompiledCondition::Any(items) => items
            .iter()
            .any(|c| eval_condition(c, post, folded, char_len_cache, extracted)),
        CompiledCondition::Not(inner) => {
            !eval_condition(inner, post, folded, char_len_cache, extracted)
        }
        CompiledCondition::KwAny(items) => items.matches_any(folded),
        CompiledCondition::KwNone(items) => !items.matches_any(folded),
        CompiledCondition::Re(re) => {
            re.is_match(folded.text_fold)
                || (!re.as_str().is_ascii() && re.is_match(&post.text_norm))
        }
        CompiledCondition::HasField(f) => extracted
            .get(f)
            .map(|ef| !ef.value.is_null())
            .unwrap_or(false),
        CompiledCondition::LenLt(limit) => {
            if post.text_norm.len() < *limit {
                true
            } else if post.text_norm.len() >= limit.saturating_mul(4) {
                false
            } else {
                get_char_len(&post.text_norm, char_len_cache) < *limit
            }
        }
        CompiledCondition::LenGt(limit) => {
            if post.text_norm.len() <= *limit {
                false
            } else if post.text_norm.len() > limit.saturating_mul(4) {
                true
            } else {
                get_char_len(&post.text_norm, char_len_cache) > *limit
            }
        }
        CompiledCondition::LangIn(langs) => {
            let post_lang = canonical_lang_code(&post.lang);
            langs.iter().any(|l| l == post_lang)
        }
        CompiledCondition::FieldCmp(cmp) => extracted
            .get(&cmp.field)
            .map(|ef| compare_field_value(&ef.value, cmp.op, &cmp.value))
            .unwrap_or(false),
    }
}

/// Evaluate a [`RulesetBody`] on a normalized post (`05-pipeline-rules.md §6.2`).
pub fn evaluate_ruleset(
    ruleset: &RulesetBody,
    post: &NormalizedText,
    field_defs: &[FieldDef],
    ref_ts_ms: i64,
) -> Result<RulesetOutcome, RulesetValidationError> {
    let compiled = compile_ruleset_unchecked(ruleset)?;
    Ok(compiled.evaluate(post, field_defs, ref_ts_ms))
}
