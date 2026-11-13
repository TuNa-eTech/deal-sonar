use std::collections::HashMap;
use std::sync::LazyLock;

use crate::normalize::{fold_text, fold_with_spans, FoldedView};
use crate::types::{ExtractionMatch, LocationValue};

mod data;
mod index;
mod matcher;

use data::*;
use index::*;
pub(crate) use matcher::*;

static VN_ADMIN_INDEX: LazyLock<GazetteerIndex> = LazyLock::new(build_vn_admin_index);

/// Extract Vietnamese administrative locations (`vn_admin`) from `text_norm` (`05-pipeline-rules.md §6.3`).
///
/// Covers all 63/34 provinces & cities, full districts and major wards/areas for Hà Nội, TP.HCM,
/// Đà Nẵng, Hải Phòng, Cần Thơ, Bình Dương, Đồng Nai, Khánh Hoà, Bắc Ninh, Hưng Yên, Quảng Ninh,
/// Bà Rịa - Vũng Tàu, etc., plus popular abbreviations (`q1`..`q12`, `cg`, `ntl`, `btl`, `tx`,
/// `dd`, `hbt`, `hm`, `lb`, `tp thu duc`, `hn`, `hcm`, `sg`, `dn`).
pub fn extract_gazetteer(text_norm: &str, scope: Option<&str>) -> Vec<ExtractionMatch> {
    if text_norm.is_empty() {
        return Vec::new();
    }
    let folded = fold_with_spans(text_norm);
    extract_gazetteer_from_folded(text_norm, &folded.as_view(text_norm), scope, false)
}
