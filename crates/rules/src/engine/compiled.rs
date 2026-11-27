//! Compiled ruleset representation.

use super::*;

// ---------- Precompiled engine structures ----------

#[derive(Debug, Clone)]
pub(super) enum CompiledPatternItem {
    Keyword(String),
    Regex(Regex),
}

/// Precompiled pattern list using shared [`FoldedView::words`] lookup (`CompiledEnumPatterns`)
/// plus linear-time compiled regexes.
#[derive(Debug, Clone, Default)]
pub(super) struct CompiledPatternList {
    pub(super) keyword_items: Vec<String>,
    pub(super) kw_patterns: Option<Box<CompiledEnumPatterns>>,
    pub(super) regex_items: Vec<Regex>,
}

impl CompiledPatternList {
    pub(super) fn from_items(items: Vec<CompiledPatternItem>) -> Self {
        let mut keyword_items = Vec::new();
        let mut regex_items = Vec::new();
        for item in items {
            match item {
                CompiledPatternItem::Keyword(kw) => keyword_items.push(kw),
                CompiledPatternItem::Regex(re) => regex_items.push(re),
            }
        }
        let kw_patterns = if keyword_items.len() >= 3 {
            let mut map = BTreeMap::new();
            map.insert("_".to_string(), keyword_items.clone());
            Some(Box::new(compile_enum_patterns(&map)))
        } else {
            None
        };

        Self {
            keyword_items,
            kw_patterns,
            regex_items,
        }
    }

    #[inline]
    pub(super) fn is_empty(&self) -> bool {
        self.keyword_items.is_empty() && self.regex_items.is_empty()
    }

    pub(super) fn matches_any(&self, folded: &FoldedView<'_>) -> bool {
        let kw_match = if let Some(pat) = &self.kw_patterns {
            matches_any_enum_kw(folded, pat)
        } else {
            self.keyword_items
                .iter()
                .any(|kw| kw_contains_folded(folded.text_fold, kw))
        };
        kw_match
            || self
                .regex_items
                .iter()
                .any(|re| re.is_match(folded.text_fold))
    }
}

#[derive(Debug, Clone)]
pub(super) struct CompiledPrefilter {
    pub(super) any: CompiledPatternList,
    pub(super) none: CompiledPatternList,
    pub(super) min_len: Option<usize>,
}

#[derive(Debug, Clone)]
pub(super) enum CompiledCondition {
    All(Vec<CompiledCondition>),
    Any(Vec<CompiledCondition>),
    Not(Box<CompiledCondition>),
    KwAny(CompiledPatternList),
    KwNone(CompiledPatternList),
    Re(Regex),
    HasField(String),
    LenLt(usize),
    LenGt(usize),
    LangIn(Vec<String>),
    FieldCmp(FieldCmp),
}

#[derive(Debug, Clone)]
pub(super) struct CompiledClassifyRule {
    pub(super) id: String,
    pub(super) when: CompiledCondition,
    pub(super) verdict: RuleVerdict,
    pub(super) confidence: f64,
    pub(super) set: BTreeMap<String, Value>,
}

#[derive(Debug, Clone)]
pub(super) enum CompiledExtractor {
    VnMoney {
        near_folded: Vec<String>,
        window: usize,
    },
    VnPhone,
    VnArea,
    Gazetteer {
        scope: Option<String>,
    },
    Number(NumberExtractorConfig),
    DateVi,
    EnumKw {
        patterns: Box<CompiledEnumPatterns>,
        multi: bool,
    },
    Regex {
        regex: Regex,
        group: usize,
        cast: RegexCast,
    },
}

#[derive(Debug, Clone)]
pub(super) struct CompiledExtractRule {
    pub(super) field: String,
    pub(super) extractor: CompiledExtractor,
}

/// Precompiled, linear-time executable ruleset (`< 1 ms` per post).
#[derive(Debug, Clone)]
pub struct CompiledRuleset {
    pub(super) prefilter: Option<CompiledPrefilter>,
    pub(super) classify: Vec<CompiledClassifyRule>,
    pub(super) extract: Vec<CompiledExtractRule>,
    pub(super) thresholds: Thresholds,
}
