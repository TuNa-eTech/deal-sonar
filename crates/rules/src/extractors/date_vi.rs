use std::sync::LazyLock;

use chrono::{Datelike, Duration, FixedOffset, NaiveDate, TimeZone, Weekday};
use regex::Regex;
use serde_json::Value;

use crate::normalize::{fold_with_spans, FoldedView};
use crate::types::ExtractionMatch;

static ISO_DATE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u)\b(?P<y>20\d{2}|19\d{2})-(?P<m>0[1-9]|1[0-2])-(?P<d>0[1-9]|[12]\d|3[01])\b")
        .expect("valid iso date regex")
});

static DMY_DATE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?-u)\b(?:ngay\s+)?(?P<d>0?[1-9]|[12]\d|3[01])[/-](?P<m>0?[1-9]|1[0-2])[/-](?P<y>20\d{2}|19\d{2}|\d{2})\b",
    )
    .expect("valid dmy date regex")
});

static DM_TEXT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u)\b(?:ngay\s+)?(?P<d>0?[1-9]|[12]\d|3[01])\s+thang\s+(?P<m>0?[1-9]|1[0-2])(?:\s+nam\s+(?P<y>20\d{2}))?\b")
        .expect("valid dm text regex")
});

static DM_SLASH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u)\b(?P<prefix>ngay\s+)?(?P<d>0?[1-9]|[12]\d|3[01])/(?P<m>0?[1-9]|1[0-2])\b")
        .expect("valid dm slash regex")
});

static IN_N_DAYS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u)\b(?:sau\s+(?P<n1>\d{1,2})\s+ngay|(?P<n2>\d{1,2})\s+ngay\s+(?:nua|toi))\b")
        .expect("valid in n days regex")
});

static SPECIFIC_MONTH_BOUND_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u)\b(?P<pos>dau|giua|cuoi)\s+thang\s+(?P<m>0?[1-9]|1[0-2])(?:\s*[/\-]\s*(?P<y>20\d{2}))?\b")
        .expect("valid month bound regex")
});

static NON_DATE_BEFORE_SLASH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u)(?:ngo|ngach|hem|so|duong|kiet|tang|lau|can|lo|ty\s+le|ti\s+le)\s*$")
        .expect("valid non-date prefix regex")
});

/// Resolve reference timestamp (Unix ms) to a calendar date in Vietnam time (`UTC+7`).
pub fn ref_date_from_ts_ms(ref_ts_ms: i64) -> NaiveDate {
    let vn_offset = FixedOffset::east_opt(7 * 3600).expect("valid +07:00 offset");
    if let Some(dt) = vn_offset.timestamp_millis_opt(ref_ts_ms).single() {
        dt.date_naive()
    } else {
        NaiveDate::from_ymd_opt(2026, 1, 1).expect("valid fallback date")
    }
}

/// Extract relative and absolute Vietnamese dates (`hôm nay`, `mai`, `ngày mai`, `cuối tuần`,
/// `cuối tháng này`, `đầu tháng sau`, `15/11`, `15/11/2026`, ISO `YYYY-MM-DD`) into ISO 8601
/// `"YYYY-MM-DD"` strings (`05-pipeline-rules.md §6.3`).
pub fn extract_date_vi(text_norm: &str, ref_ts_ms: i64) -> Vec<ExtractionMatch> {
    if text_norm.is_empty() {
        return Vec::new();
    }
    let folded = fold_with_spans(text_norm);
    extract_date_vi_from_folded(text_norm, &folded.as_view(text_norm), ref_ts_ms)
}

pub(crate) fn extract_date_vi_from_folded(
    text_norm: &str,
    folded: &FoldedView<'_>,
    ref_ts_ms: i64,
) -> Vec<ExtractionMatch> {
    let tf = folded.text_fold;
    if tf.is_empty() {
        return Vec::new();
    }
    let ref_date = ref_date_from_ts_ms(ref_ts_ms);
    let mut hits: Vec<(usize, usize, NaiveDate, f64)> = Vec::new();

    let has_dash = tf.as_bytes().contains(&b'-');
    let has_slash = tf.as_bytes().contains(&b'/');
    let has_thang = tf.contains("thang");
    let has_ngay = tf.contains("ngay");

    // 1. Explicit ISO YYYY-MM-DD
    if has_dash {
        for m in ISO_DATE_RE.find_iter(tf) {
            let Some(caps) = ISO_DATE_RE.captures(m.as_str()) else {
                continue;
            };
            let y: i32 = caps["y"].parse().unwrap_or(0);
            let mo: u32 = caps["m"].parse().unwrap_or(0);
            let d: u32 = caps["d"].parse().unwrap_or(0);
            if let Some(date) = NaiveDate::from_ymd_opt(y, mo, d) {
                hits.push((m.start(), m.end(), date, 0.99));
            }
        }
    }

    // 2. Explicit DD/MM/YYYY or DD-MM-YYYY
    if has_slash || has_dash {
        for m in DMY_DATE_RE.find_iter(tf) {
            if overlaps(&hits, m.start(), m.end()) {
                continue;
            }
            let Some(caps) = DMY_DATE_RE.captures(m.as_str()) else {
                continue;
            };
            let d: u32 = caps["d"].parse().unwrap_or(0);
            let mo: u32 = caps["m"].parse().unwrap_or(0);
            let raw_y: i32 = caps["y"].parse().unwrap_or(0);
            let y = if raw_y < 100 { 2000 + raw_y } else { raw_y };
            if (1970..=2100).contains(&y) {
                if let Some(date) = NaiveDate::from_ymd_opt(y, mo, d) {
                    hits.push((m.start(), m.end(), date, 0.98));
                }
            }
        }
    }

    // 3. "ngày 15 tháng 11 [năm 2026]"
    if has_thang {
        for m in DM_TEXT_RE.find_iter(tf) {
            if overlaps(&hits, m.start(), m.end()) {
                continue;
            }
            let Some(caps) = DM_TEXT_RE.captures(m.as_str()) else {
                continue;
            };
            let d: u32 = caps["d"].parse().unwrap_or(0);
            let mo: u32 = caps["m"].parse().unwrap_or(0);
            let date_opt = if let Some(ym) = caps.name("y") {
                ym.as_str()
                    .parse::<i32>()
                    .ok()
                    .and_then(|y| NaiveDate::from_ymd_opt(y, mo, d))
            } else {
                resolve_day_month(ref_date, d, mo)
            };
            if let Some(date) = date_opt {
                hits.push((m.start(), m.end(), date, 0.96));
            }
        }

        // 4. Specific month boundaries ("đầu tháng 12", "cuối tháng 11")
        for m in SPECIFIC_MONTH_BOUND_RE.find_iter(tf) {
            if overlaps(&hits, m.start(), m.end()) {
                continue;
            }
            let Some(caps) = SPECIFIC_MONTH_BOUND_RE.captures(m.as_str()) else {
                continue;
            };
            let mo: u32 = caps["m"].parse().unwrap_or(0);
            let y = caps
                .name("y")
                .and_then(|ym| ym.as_str().parse::<i32>().ok())
                .unwrap_or_else(|| {
                    if mo < ref_date.month() {
                        ref_date.year() + 1
                    } else {
                        ref_date.year()
                    }
                });
            let date_opt = match &caps["pos"] {
                "dau" => NaiveDate::from_ymd_opt(y, mo, 1),
                "giua" => NaiveDate::from_ymd_opt(y, mo, 15),
                "cuoi" => last_day_of_month(y, mo),
                _ => None,
            };
            if let Some(date) = date_opt {
                hits.push((m.start(), m.end(), date, 0.92));
            }
        }
    }

    // 5. Short DD/MM (guarded against alley/street addresses like "ngõ 15/11", "đường 3/2", "24/7")
    if has_slash {
        for m in DM_SLASH_RE.find_iter(tf) {
            if overlaps(&hits, m.start(), m.end()) {
                continue;
            }
            // Reject if followed by "/..." (e.g. alley 12/5/3)
            if tf[m.end()..].starts_with('/') {
                continue;
            }
            let Some(caps) = DM_SLASH_RE.captures(m.as_str()) else {
                continue;
            };
            let has_ngay_prefix = caps.name("prefix").is_some();
            let d: u32 = caps["d"].parse().unwrap_or(0);
            let mo: u32 = caps["m"].parse().unwrap_or(0);
            if !has_ngay_prefix {
                if d == 24 && (mo == 7 || mo == 24) {
                    continue;
                }
                if NON_DATE_BEFORE_SLASH_RE.is_match(&tf[..m.start()]) {
                    continue;
                }
            }
            if let Some(date) = resolve_day_month(ref_date, d, mo) {
                hits.push((
                    m.start(),
                    m.end(),
                    date,
                    if has_ngay_prefix { 0.95 } else { 0.88 },
                ));
            }
        }
    }

    // 6. Relative N days ("3 ngày nữa", "sau 5 ngày")
    if has_ngay {
        for m in IN_N_DAYS_RE.find_iter(tf) {
            if overlaps(&hits, m.start(), m.end()) {
                continue;
            }
            let Some(caps) = IN_N_DAYS_RE.captures(m.as_str()) else {
                continue;
            };
            let n_str = caps
                .name("n1")
                .or_else(|| caps.name("n2"))
                .map(|cm| cm.as_str())
                .unwrap_or("0");
            if let Ok(days) = n_str.parse::<i64>() {
                if let Some(date) = ref_date.checked_add_signed(Duration::days(days)) {
                    hits.push((m.start(), m.end(), date, 0.92));
                }
            }
        }
    }

    // 7. Relative Vietnamese date phrases (longest phrases first so "ngày mai" beats "mai",
    // "cuối tháng này" beats "cuối tháng", etc.)
    type RelativePhraseRule = (&'static str, fn(NaiveDate) -> Option<NaiveDate>, f64);
    let relative_phrases: &[RelativePhraseRule] = &[
        ("ngay hom nay", |d| Some(d), 0.96),
        ("hom nay", |d| Some(d), 0.96),
        ("bua nay", |d| Some(d), 0.94),
        (
            "ngay mai",
            |d| d.checked_add_signed(Duration::days(1)),
            0.96,
        ),
        (
            "sang mai",
            |d| d.checked_add_signed(Duration::days(1)),
            0.95,
        ),
        (
            "chieu mai",
            |d| d.checked_add_signed(Duration::days(1)),
            0.95,
        ),
        ("toi mai", |d| d.checked_add_signed(Duration::days(1)), 0.95),
        (
            "ngay kia",
            |d| d.checked_add_signed(Duration::days(2)),
            0.95,
        ),
        (
            "ngay mot",
            |d| d.checked_add_signed(Duration::days(2)),
            0.95,
        ),
        ("hom qua", |d| d.checked_sub_signed(Duration::days(1)), 0.95),
        ("cuoi tuan nay", |d| Some(upcoming_weekend(d, 0)), 0.92),
        ("cuoi tuan sau", |d| Some(upcoming_weekend(d, 1)), 0.92),
        ("cuoi tuan", |d| Some(upcoming_weekend(d, 0)), 0.90),
        ("dau tuan sau", |d| Some(next_monday(d)), 0.91),
        ("tuan sau", |d| Some(next_monday(d)), 0.86),
        (
            "cuoi thang nay",
            |d| last_day_of_month(d.year(), d.month()),
            0.94,
        ),
        (
            "cuoi thang sau",
            |d| {
                let (ny, nm) = next_month(d.year(), d.month());
                last_day_of_month(ny, nm)
            },
            0.94,
        ),
        (
            "cuoi thang",
            |d| last_day_of_month(d.year(), d.month()),
            0.91,
        ),
        (
            "dau thang sau",
            |d| {
                let (ny, nm) = next_month(d.year(), d.month());
                NaiveDate::from_ymd_opt(ny, nm, 1)
            },
            0.95,
        ),
        (
            "dau thang toi",
            |d| {
                let (ny, nm) = next_month(d.year(), d.month());
                NaiveDate::from_ymd_opt(ny, nm, 1)
            },
            0.94,
        ),
        (
            "sang thang",
            |d| {
                let (ny, nm) = next_month(d.year(), d.month());
                NaiveDate::from_ymd_opt(ny, nm, 1)
            },
            0.88,
        ),
        (
            "dau thang nay",
            |d| NaiveDate::from_ymd_opt(d.year(), d.month(), 1),
            0.93,
        ),
        (
            "giua thang nay",
            |d| NaiveDate::from_ymd_opt(d.year(), d.month(), 15),
            0.91,
        ),
        (
            "giua thang sau",
            |d| {
                let (ny, nm) = next_month(d.year(), d.month());
                NaiveDate::from_ymd_opt(ny, nm, 15)
            },
            0.91,
        ),
        (
            "chu nhat",
            |d| Some(upcoming_weekday(d, Weekday::Sun)),
            0.90,
        ),
        ("mai", |d| d.checked_add_signed(Duration::days(1)), 0.88),
    ];

    for &(phrase, compute, conf) in relative_phrases {
        let mut from = 0usize;
        while let Some(rel) = tf[from..].find(phrase) {
            let start = from + rel;
            let end = start + phrase.len();
            let left_ok = start == 0
                || !tf[..start]
                    .chars()
                    .next_back()
                    .map(|c| c.is_alphanumeric())
                    .unwrap_or(false);
            let right_ok = end == tf.len()
                || !tf[end..]
                    .chars()
                    .next()
                    .map(|c| c.is_alphanumeric())
                    .unwrap_or(false);

            // Guard bare "mai" against proper names / district names ("Hoàng Mai", "Tân Mai", "Phương Mai", "Bạch Mai", "Khương Mai", "sớm mai", "hoa mai", "khuyến mãi" -> "khuyen mai"!)
            let context_ok = if phrase == "mai" {
                bare_mai_context_ok(tf, start, end)
            } else {
                true
            };

            if left_ok && right_ok && context_ok && !overlaps(&hits, start, end) {
                if let Some(date) = compute(ref_date) {
                    hits.push((start, end, date, conf));
                }
            }
            let step = tf[start..]
                .chars()
                .next()
                .map(|c| c.len_utf8())
                .unwrap_or(1);
            from = start + step;
        }
    }

    hits.sort_by_key(|h| h.0);
    hits.into_iter()
        .filter_map(|(s, e, date, conf)| {
            let (ns, ne) = folded.map_span(s, e)?;
            Some(ExtractionMatch {
                value: Value::String(date.format("%Y-%m-%d").to_string()),
                raw: text_norm[ns..ne].to_string(),
                start: ns,
                end: ne,
                confidence: conf,
            })
        })
        .collect()
}

fn bare_mai_context_ok(tf: &str, start: usize, end: usize) -> bool {
    let before = tf[..start].trim_end();
    const NON_TOMORROW_BEFORE: &[&str] = &[
        "hoang", "tan", "phuong", "bach", "khuong", "xuan", "ban", "sao", "hoa", "cay", "khuyen",
        "thuong", "mai", "chi", "co", "anh", "em", "dong",
    ];
    for w in NON_TOMORROW_BEFORE {
        if let Some(rest) = before.strip_suffix(w) {
            if rest.is_empty()
                || !rest
                    .chars()
                    .next_back()
                    .map(|c| c.is_alphanumeric())
                    .unwrap_or(false)
            {
                return false;
            }
        }
    }
    let after = tf[end..].trim_start();
    if after.starts_with("dich") || after.starts_with("dong") || after.starts_with("moi") {
        return false; // "Mai Dịch", "Mai Động", "môi giới" / "mãi mới"
    }
    true
}

fn resolve_day_month(ref_date: NaiveDate, day: u32, month: u32) -> Option<NaiveDate> {
    let same_year = NaiveDate::from_ymd_opt(ref_date.year(), month, day);
    if let Some(cand) = same_year {
        // If more than 60 days before `ref_date`, roll forward to next year (e.g. "05/01" posted in Dec)
        if (ref_date - cand).num_days() > 60 {
            if let Some(next_yr) = NaiveDate::from_ymd_opt(ref_date.year() + 1, month, day) {
                return Some(next_yr);
            }
        }
        return Some(cand);
    }
    // E.g. 29/02 when current year is not leap year -> check next year
    NaiveDate::from_ymd_opt(ref_date.year() + 1, month, day)
}

fn next_month(year: i32, month: u32) -> (i32, u32) {
    if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    }
}

fn last_day_of_month(year: i32, month: u32) -> Option<NaiveDate> {
    let (ny, nm) = next_month(year, month);
    NaiveDate::from_ymd_opt(ny, nm, 1)?.pred_opt()
}

fn upcoming_weekend(d: NaiveDate, extra_weeks: i64) -> NaiveDate {
    let sat = match d.weekday() {
        Weekday::Sun if extra_weeks == 0 => d,
        wd => {
            // `num_days_from_monday`: Mon=0 .. Sat=5, Sun=6
            let days_until_sat = (5 + 7 - wd.num_days_from_monday() as i64) % 7;
            d + Duration::days(days_until_sat)
        }
    };
    sat + Duration::days(extra_weeks * 7)
}

fn next_monday(d: NaiveDate) -> NaiveDate {
    let days_from_mon = d.weekday().num_days_from_monday() as i64;
    let delta = 7 - days_from_mon;
    d + Duration::days(delta)
}

fn upcoming_weekday(d: NaiveDate, target: Weekday) -> NaiveDate {
    let cur = d.weekday().num_days_from_monday() as i64;
    let tgt = target.num_days_from_monday() as i64;
    let delta = (tgt - cur + 7) % 7;
    d + Duration::days(delta)
}

fn overlaps(existing: &[(usize, usize, NaiveDate, f64)], s: usize, e: usize) -> bool {
    existing.iter().any(|&(es, ee, _, _)| s < ee && e > es)
}
