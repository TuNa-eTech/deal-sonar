//! Gazetteer matching over folded text, with location cue and hierarchy checks.

use super::*;

pub(crate) fn extract_gazetteer_from_folded(
    text_norm: &str,
    folded: &FoldedView<'_>,
    scope: Option<&str>,
    first_only: bool,
) -> Vec<ExtractionMatch> {
    let tf = folded.text_fold;
    if tf.is_empty() {
        return Vec::new();
    }

    let idx = &*VN_ADMIN_INDEX;
    let canonical_scope: Option<&str> = scope.and_then(|s| {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            return None;
        }
        let f = fold_text(trimmed);
        let f_nodot = f.replace('.', " ");
        let f_collapsed = f_nodot.split_whitespace().collect::<Vec<_>>().join(" ");
        idx.province_scope_map
            .get(f.as_str())
            .or_else(|| idx.province_scope_map.get(f_collapsed.as_str()))
            .copied()
            .or(Some(trimmed))
    });

    let mut raw_hits: Vec<(usize, usize, AdminEntry, f64)> = Vec::new();
    let bytes = tf.as_bytes();
    let len = bytes.len();
    let mut skip_until = 0usize;

    for &(ws_u32, we_u32) in folded.words() {
        let word_start = ws_u32 as usize;
        if first_only {
            if let Some(&(_, last_end, _, _)) = raw_hits.last() {
                if word_start.saturating_sub(last_end) > 25 {
                    break;
                }
            }
        }
        if word_start < skip_until {
            continue;
        }
        let word_end = we_u32 as usize;
        let wlen = word_end - word_start;
        let b0 = bytes[word_start];
        let b1 = if wlen >= 2 { bytes[word_start + 1] } else { 0 };
        let wlen_bit = 1u64 << if wlen < 63 { wlen } else { 63 };
        if b0 < 128
            && b1 < 128
            && (idx.first_word_mask[b0 as usize] & wlen_bit) != 0
            && (idx.first_two_mask[b0 as usize] & (1u128 << b1)) != 0
        {
            if let Some((match_end, entry, conf)) =
                try_match_gazetteer_word(tf, bytes, len, idx, canonical_scope, word_start, word_end)
            {
                raw_hits.push((word_start, match_end, entry, conf));
                skip_until = match_end;
            }
        }
    }

    if raw_hits.is_empty() {
        return Vec::new();
    }

    struct MergedLocationHit {
        start: usize,
        end: usize,
        province: Option<&'static str>,
        district: Option<&'static str>,
        ward: Option<&'static str>,
        confidence: f64,
    }

    // Merge adjacent compatible hierarchical mentions (e.g. "Dịch Vọng, Cầu Giấy, Hà Nội")
    let mut merged: Vec<MergedLocationHit> = Vec::with_capacity(raw_hits.len());

    for (s, e, entry, conf) in raw_hits {
        if let Some(last) = merged.last_mut() {
            let gap = &tf[last.end..s];
            if is_location_connector(gap)
                && compatible_hierarchy(
                    (last.province, last.district, last.ward),
                    (Some(entry.province), entry.district, entry.ward),
                )
            {
                last.end = e;
                last.province = last.province.or(Some(entry.province));
                if last.district.is_none() {
                    last.district = entry.district;
                }
                if last.ward.is_none() {
                    last.ward = entry.ward;
                }
                last.confidence = last.confidence.max(conf).max(0.96);
                continue;
            }
        }
        merged.push(MergedLocationHit {
            start: s,
            end: e,
            province: Some(entry.province),
            district: entry.district,
            ward: entry.ward,
            confidence: conf,
        });
    }

    merged
        .into_iter()
        .filter_map(|hit| {
            let (ns, ne) = folded.map_span(hit.start, hit.end)?;
            let raw = text_norm[ns..ne].to_string();
            let loc = LocationValue {
                raw: raw.clone(),
                province: hit.province.map(str::to_string),
                district: hit.district.map(str::to_string),
                ward: hit.ward.map(str::to_string),
            };
            Some(ExtractionMatch {
                value: serde_json::to_value(loc).ok()?,
                raw,
                start: ns,
                end: ne,
                confidence: hit.confidence,
            })
        })
        .collect()
}

pub(super) fn scan_alnum_end(s: &str, start: usize) -> usize {
    let bytes = s.as_bytes();
    let mut idx = start;
    while idx < bytes.len() {
        let b = bytes[idx];
        if b < 0x80 {
            if b.is_ascii_alphanumeric() {
                idx += 1;
            } else {
                break;
            }
        } else if let Some(ch) = s[idx..].chars().next() {
            if ch.is_alphanumeric() {
                idx += ch.len_utf8();
            } else {
                break;
            }
        } else {
            break;
        }
    }
    idx
}

pub(super) fn is_location_connector(gap: &str) -> bool {
    let g = gap.trim();
    matches!(
        g,
        "" | ","
            | "-"
            | "/"
            | "."
            | ", quan"
            | ", q."
            | ", phuong"
            | ", p."
            | ", huyen"
            | ", tp"
            | "quan"
            | "tp"
    )
}

pub(super) fn compatible_hierarchy(
    a: (Option<&str>, Option<&str>, Option<&str>),
    b: (Option<&str>, Option<&str>, Option<&str>),
) -> bool {
    if let (Some(pa), Some(pb)) = (a.0, b.0) {
        if pa != pb {
            return false;
        }
    }
    if let (Some(da), Some(db)) = (a.1, b.1) {
        if da != db {
            return false;
        }
    }
    if let (Some(wa), Some(wb)) = (a.2, b.2) {
        if wa != wb {
            return false;
        }
    }
    // Only merge when one adds strictly new hierarchy level or confirms parent
    a != b
}

pub(super) fn has_location_cue_before(tf: &str, pos: usize) -> bool {
    let prefix = tf[..pos].trim_end_matches([' ', ',', ':', '-', '(', '/']);
    const CUES: &[&str] = &[
        "khu vuc", "kv", "khu", "quan", "q", "huyen", "phuong", "man", "o", "tai", "gan", "quanh",
        "ben", "huong", "tuyen", "di", "den", "ve",
    ];
    for cue in CUES {
        if let Some(before) = prefix.strip_suffix(cue) {
            if before.is_empty()
                || !before
                    .chars()
                    .next_back()
                    .map(|c| c.is_alphanumeric())
                    .unwrap_or(false)
            {
                return true;
            }
        }
    }
    false
}

pub(super) fn short_alias_context_ok(tf: &str, pos: usize, end_pos: usize, phrase: &str) -> bool {
    // Avoid matching "tx" when used as prefix "thị xã <name>" (e.g. "tx son tay", "tx tu son")
    if phrase == "tx" {
        let after = tf[end_pos..].trim_start();
        if after.starts_with("son tay")
            || after.starts_with("tu son")
            || after.starts_with("phu my")
            || after.starts_with("ben cat")
            || after.starts_with("tan uyen")
            || after.starts_with("dong trieu")
            || after.starts_with("quang yen")
            || after.starts_with("ninh hoa")
        {
            return false;
        }
    }
    // Avoid matching "tb" inside "thiet bi" abbreviation or "trung binh" if preceded by "gia "
    if phrase == "tb" && tf[..pos].ends_with("gia ") {
        return false;
    }
    true
}

#[inline]
pub(super) fn try_match_gazetteer_word(
    tf: &str,
    bytes: &[u8],
    len: usize,
    idx: &GazetteerIndex,
    canonical_scope: Option<&str>,
    pos: usize,
    first_end: usize,
) -> Option<(usize, AdminEntry, f64)> {
    let bucket = idx.by_first_word.get(&tf[pos..first_end])?;
    let next_b = if first_end + 1 < len {
        bytes[first_end + 1]
    } else {
        0
    };
    let next_b2 = if first_end + 2 < len {
        bytes[first_end + 2]
    } else {
        0
    };
    let can_match_long = next_b < 128 && (bucket.next_byte_mask & (1u128 << next_b)) != 0;
    if !bucket.has_short_phrase && !can_match_long {
        return None;
    }

    let mut best: Option<(usize, AdminEntry, f64)> = None;
    for &(phrase, meta) in &bucket.items {
        if (meta.next_byte != 0 && meta.next_byte != next_b)
            || (meta.next_byte2 != 0 && meta.next_byte2 != next_b2)
        {
            continue;
        }
        let end_pos = pos + phrase.len();
        if end_pos > len || !tf[pos..].starts_with(phrase) {
            continue;
        }
        let entry = idx.entries[meta.entry_idx];
        if let Some(req_prov) = canonical_scope {
            if !entry.province.eq_ignore_ascii_case(req_prov) && entry.province != req_prov {
                continue;
            }
        }
        if crate::prefilter::has_alnum_at(tf, end_pos) {
            continue;
        }
        if meta.is_short && !short_alias_context_ok(tf, pos, end_pos, phrase) {
            continue;
        }

        let conf = if meta.is_short {
            if canonical_scope.is_some() || has_location_cue_before(tf, pos) {
                0.90
            } else {
                0.80
            }
        } else if entry.ward.is_some() {
            0.97
        } else if entry.district.is_some() {
            0.95
        } else {
            0.93
        };

        if let Some((best_end, _, best_conf)) = best {
            if end_pos > best_end || (end_pos == best_end && conf > best_conf) {
                best = Some((end_pos, entry, conf));
            }
        } else {
            best = Some((end_pos, entry, conf));
        }
    }
    best
}
