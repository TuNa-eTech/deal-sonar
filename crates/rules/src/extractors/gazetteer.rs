use std::collections::HashMap;
use std::sync::LazyLock;

use crate::normalize::{fold_text, fold_with_spans, FoldedView};
use crate::types::{ExtractionMatch, LocationValue};

#[derive(Debug, Clone, Copy)]
struct AdminEntry {
    province: &'static str,
    district: Option<&'static str>,
    ward: Option<&'static str>,
    /// Unambiguous folded aliases/names
    aliases: &'static [&'static str],
    /// Short abbreviations (e.g. `cg`, `tx`, `dd`, `hm`, `lb`, `dn`)
    short_aliases: &'static [&'static str],
}

#[derive(Debug, Clone, Copy)]
struct CompiledAlias {
    entry_idx: usize,
    is_short: bool,
    /// `0` if `phrase.len() <= first_word.len() + 1`, else `phrase.as_bytes()[first_word.len() + 1]`
    next_byte: u8,
}

struct FirstWordBucket {
    has_short_phrase: bool,
    next_byte_mask: u128,
    items: Vec<(&'static str, CompiledAlias)>,
}

struct FastStaticWordMap<V> {
    mask: usize,
    slots: Vec<Option<(&'static str, V)>>,
}

impl<V> FastStaticWordMap<V> {
    fn with_capacity(entries_len: usize) -> Self {
        let cap = (entries_len.saturating_mul(8)).next_power_of_two().max(64);
        let mut slots = Vec::with_capacity(cap);
        slots.resize_with(cap, || None);
        Self {
            mask: cap - 1,
            slots,
        }
    }

    #[inline(always)]
    fn hash_word(bytes: &[u8]) -> usize {
        let mut h = 0xcbf2_9ce4_8422_2325_u64;
        let mut i = 0usize;
        while i < bytes.len() {
            h = (h ^ (bytes[i] as u64)).wrapping_mul(0x0100_0000_01b3);
            i += 1;
        }
        (h ^ (h >> 32)) as usize
    }

    fn insert(&mut self, key: &'static str, val: V) {
        let mut idx = Self::hash_word(key.as_bytes()) & self.mask;
        loop {
            match &mut self.slots[idx] {
                None => {
                    self.slots[idx] = Some((key, val));
                    return;
                }
                Some((k, existing)) if *k == key => {
                    *existing = val;
                    return;
                }
                Some(_) => {
                    idx = (idx + 1) & self.mask;
                }
            }
        }
    }

    #[inline(always)]
    fn get(&self, key: &str) -> Option<&V> {
        let kb = key.as_bytes();
        let mut idx = Self::hash_word(kb) & self.mask;
        loop {
            match &self.slots[idx] {
                None => return None,
                Some((k, v)) => {
                    if k.len() == kb.len() && k.as_bytes() == kb {
                        return Some(v);
                    }
                    idx = (idx + 1) & self.mask;
                }
            }
        }
    }
}

struct GazetteerIndex {
    entries: Vec<AdminEntry>,
    /// Fast `(first_byte, word_len)` bitmask prefilter before table lookup.
    first_word_mask: [u64; 256],
    /// Open-addressed FNV-1a table from first token -> `FirstWordBucket` (avoids SipHash per word).
    by_first_word: FastStaticWordMap<FirstWordBucket>,
    /// Map from folded province alias -> canonical province name (for `scope` resolution)
    province_scope_map: HashMap<&'static str, &'static str>,
}

const IS_ASCII_ALNUM: [bool; 256] = {
    let mut t = [false; 256];
    let mut i = 0usize;
    while i < 256 {
        let b = i as u8;
        t[i] = (b >= b'a' && b <= b'z') || (b >= b'A' && b <= b'Z') || (b >= b'0' && b <= b'9');
        i += 1;
    }
    t
};

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

    // Tokenize `tf` into alphanumeric/dot words (splitting on spaces and punctuation except '.' inside "q.1", "q.7")
    // Actually scanning word boundaries directly on `tf` handles both "q.7" and multi-word "tp thu duc" cleanly!
    let mut raw_hits: Vec<(usize, usize, AdminEntry, f64)> = Vec::new();
    let bytes = tf.as_bytes();
    let len = bytes.len();
    let mut pos = 0usize;

    while pos < len {
        if first_only {
            if let Some(&(_, last_end, _, _)) = raw_hits.last() {
                if pos.saturating_sub(last_end) > 25 {
                    break;
                }
            }
        }
        let b = bytes[pos];
        if b < 0x80 {
            if !IS_ASCII_ALNUM[b as usize] {
                pos += 1;
                continue;
            }
        } else {
            let ch = tf[pos..].chars().next().unwrap();
            if !ch.is_alphanumeric() {
                pos += ch.len_utf8();
                continue;
            }
        }
        // Because every iteration either skips non-alphanumeric bytes or jumps to `first_end`/`match_end`
        // (both guaranteed to end at a word boundary), `pos` here is always a word start.
        let mut first_end = pos + 1;
        while first_end < len && IS_ASCII_ALNUM[bytes[first_end] as usize] {
            first_end += 1;
        }
        if first_end < len && bytes[first_end] >= 0x80 {
            first_end = scan_alnum_end(tf, first_end);
        }
        let wlen = first_end - pos;
        let wlen_bit = 1u64 << if wlen < 63 { wlen } else { 63 };

        if (idx.first_word_mask[b as usize] & wlen_bit) != 0 {
            if let Some(bucket) = idx.by_first_word.get(&tf[pos..first_end]) {
                let next_b = if first_end + 1 < len {
                    bytes[first_end + 1]
                } else {
                    0
                };
                let can_match_long =
                    next_b < 128 && (bucket.next_byte_mask & (1u128 << next_b)) != 0;
                if bucket.has_short_phrase || can_match_long {
                    let mut best: Option<(usize, AdminEntry, f64)> = None;
                    for &(phrase, meta) in &bucket.items {
                        if meta.next_byte != 0 && meta.next_byte != next_b {
                            continue;
                        }
                        let end_pos = pos + phrase.len();
                        if end_pos > tf.len() || !tf[pos..].starts_with(phrase) {
                            continue;
                        }
                        let entry = idx.entries[meta.entry_idx];
                        if let Some(req_prov) = canonical_scope {
                            if !entry.province.eq_ignore_ascii_case(req_prov)
                                && entry.province != req_prov
                            {
                                continue;
                            }
                        }
                        let right_ok = !crate::prefilter::has_alnum_at(tf, end_pos);
                        if !right_ok {
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

                        // `items` is already sorted longest phrase first; among equal-length phrases,
                        // prefer scoped/more-specific entries.
                        if let Some((best_end, _, best_conf)) = best {
                            if end_pos > best_end || (end_pos == best_end && conf > best_conf) {
                                best = Some((end_pos, entry, conf));
                            }
                        } else {
                            best = Some((end_pos, entry, conf));
                        }
                    }

                    if let Some((match_end, entry, conf)) = best {
                        raw_hits.push((pos, match_end, entry, conf));
                        pos = match_end;
                        continue;
                    }
                }
            }
        }
        pos = first_end;
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

fn scan_alnum_end(s: &str, start: usize) -> usize {
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

fn is_location_connector(gap: &str) -> bool {
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

fn compatible_hierarchy(
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

fn has_location_cue_before(tf: &str, pos: usize) -> bool {
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

fn short_alias_context_ok(tf: &str, pos: usize, end_pos: usize, phrase: &str) -> bool {
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

fn p_only(
    province: &'static str,
    aliases: &'static [&'static str],
    short_aliases: &'static [&'static str],
) -> AdminEntry {
    AdminEntry {
        province,
        district: None,
        ward: None,
        aliases,
        short_aliases,
    }
}

fn dist(
    province: &'static str,
    district: &'static str,
    aliases: &'static [&'static str],
    short_aliases: &'static [&'static str],
) -> AdminEntry {
    AdminEntry {
        province,
        district: Some(district),
        ward: None,
        aliases,
        short_aliases,
    }
}

fn ward(
    province: &'static str,
    district: &'static str,
    ward_name: &'static str,
    aliases: &'static [&'static str],
) -> AdminEntry {
    AdminEntry {
        province,
        district: Some(district),
        ward: Some(ward_name),
        aliases,
        short_aliases: &[],
    }
}

fn build_vn_admin_index() -> GazetteerIndex {
    let entries = vec![
        // ======================== 63 PROVINCES & MUNICIPALITIES ========================
        p_only(
            "Hà Nội",
            &[
                "ha noi",
                "tp ha noi",
                "thanh pho ha noi",
                "hanoi",
                "thu do ha noi",
                "hn",
            ],
            &[],
        ),
        p_only(
            "TP. Hồ Chí Minh",
            &[
                "tp ho chi minh",
                "ho chi minh",
                "tp.hcm",
                "tp hcm",
                "tphcm",
                "hcm",
                "sai gon",
                "saigon",
                "sg",
            ],
            &[],
        ),
        p_only("Đà Nẵng", &["da nang", "tp da nang", "danang"], &["dn"]),
        p_only(
            "Hải Phòng",
            &["hai phong", "tp hai phong", "haiphong"],
            &["hp"],
        ),
        p_only("Cần Thơ", &["can tho", "tp can tho", "cantho"], &[]),
        p_only("Huế", &["thua thien hue", "tp hue", "hue"], &[]),
        p_only("Bình Dương", &["binh duong", "tinh binh duong"], &["bd"]),
        p_only("Đồng Nai", &["dong nai", "tinh dong nai"], &[]),
        p_only(
            "Bà Rịa - Vũng Tàu",
            &["ba ria - vung tau", "ba ria vung tau", "brvt", "br-vt"],
            &[],
        ),
        p_only("Khánh Hoà", &["khanh hoa", "tinh khanh hoa"], &[]),
        p_only("Bắc Ninh", &["bac ninh", "tinh bac ninh"], &[]),
        p_only("Hưng Yên", &["hung yen", "tinh hung yen"], &[]),
        p_only("Quảng Ninh", &["quang ninh", "tinh quang ninh"], &[]),
        p_only(
            "Vĩnh Phúc",
            &["vinh phuc", "tinh vinh phuc", "vinh yen"],
            &[],
        ),
        p_only("Bắc Giang", &["bac giang", "tp bac giang"], &[]),
        p_only("Hải Dương", &["hai duong", "tp hai duong"], &[]),
        p_only("Thái Bình", &["thai binh", "tp thai binh"], &[]),
        p_only("Nam Định", &["nam dinh", "tp nam dinh"], &[]),
        p_only("Ninh Bình", &["ninh binh", "tp ninh binh", "hoa lu"], &[]),
        p_only("Hà Nam", &["ha nam", "phu ly"], &[]),
        p_only(
            "Thái Nguyên",
            &["thai nguyen", "tp thai nguyen", "pho yen"],
            &[],
        ),
        p_only("Phú Thọ", &["phu tho", "viet tri"], &[]),
        p_only("Tuyên Quang", &["tuyen quang", "tp tuyen quang"], &[]),
        p_only("Lào Cai", &["lao cai", "tp lao cai", "sa pa", "sapa"], &[]),
        p_only("Yên Bái", &["yen bai", "tp yen bai"], &[]),
        p_only("Hà Giang", &["ha giang", "tp ha giang"], &[]),
        p_only("Cao Bằng", &["cao bang", "tp cao bang"], &[]),
        p_only("Bắc Kạn", &["bac kan", "bac can"], &[]),
        p_only("Lạng Sơn", &["lang son", "tp lang son"], &[]),
        p_only("Điện Biên", &["dien bien", "dien bien phu"], &[]),
        p_only("Lai Châu", &["lai chau", "tp lai chau"], &[]),
        p_only("Sơn La", &["son la", "tp son la", "moc chau"], &[]),
        p_only("Hoà Bình", &["hoa binh", "tp hoa binh", "luong son"], &[]),
        p_only("Thanh Hoá", &["thanh hoa", "tp thanh hoa", "sam son"], &[]),
        p_only("Nghệ An", &["nghe an", "tp vinh", "cua lo"], &[]),
        p_only("Hà Tĩnh", &["ha tinh", "tp ha tinh", "ky anh"], &[]),
        p_only("Quảng Bình", &["quang binh", "dong hoi"], &[]),
        p_only("Quảng Trị", &["quang tri", "dong ha"], &[]),
        p_only("Quảng Nam", &["quang nam", "tam ky", "hoi an"], &[]),
        p_only("Quảng Ngãi", &["quang ngai", "tp quang ngai"], &[]),
        p_only("Bình Định", &["binh dinh", "quy nhon"], &[]),
        p_only("Phú Yên", &["phu yen", "tuy hoa"], &[]),
        p_only("Ninh Thuận", &["ninh thuan", "phan rang"], &[]),
        p_only("Bình Thuận", &["binh thuan", "phan thiet", "mui ne"], &[]),
        p_only("Kon Tum", &["kon tum", "tp kon tum"], &[]),
        p_only("Gia Lai", &["gia lai", "pleiku"], &[]),
        p_only(
            "Đắk Lắk",
            &["dak lak", "dac lac", "buon ma thuot", "bmt"],
            &[],
        ),
        p_only("Đắk Nông", &["dak nong", "dac nong", "gia nghia"], &[]),
        p_only("Lâm Đồng", &["lam dong", "da lat", "dalat", "bao loc"], &[]),
        p_only("Bình Phước", &["binh phuoc", "dong xoai"], &[]),
        p_only("Tây Ninh", &["tay ninh", "tp tay ninh"], &[]),
        p_only(
            "Long An",
            &["long an", "tan an", "duc hoa", "ben luc", "can giuoc"],
            &[],
        ),
        p_only("Tiền Giang", &["tien giang", "my tho"], &[]),
        p_only("Bến Tre", &["ben tre", "tp ben tre"], &[]),
        p_only("Trà Vinh", &["tra vinh", "tp tra vinh"], &[]),
        p_only("Vĩnh Long", &["vinh long", "tp vinh long"], &[]),
        p_only("Đồng Tháp", &["dong thap", "cao lanh", "sa dec"], &[]),
        p_only("An Giang", &["an giang", "long xuyen", "chau doc"], &[]),
        p_only(
            "Kiên Giang",
            &["kien giang", "rach gia", "phu quoc", "ha tien"],
            &[],
        ),
        p_only("Hậu Giang", &["hau giang", "vi thanh"], &[]),
        p_only("Sóc Trăng", &["soc trang", "tp soc trang"], &[]),
        p_only("Bạc Liêu", &["bac lieu", "tp bac lieu"], &[]),
        p_only("Cà Mau", &["ca mau", "tp ca mau"], &[]),
        // ======================== HÀ NỘI — ALL 30 DISTRICTS ========================
        dist(
            "Hà Nội",
            "Cầu Giấy",
            &["cau giay", "quan cau giay", "q.cau giay", "q cau giay"],
            &["cg"],
        ),
        dist(
            "Hà Nội",
            "Nam Từ Liêm",
            &["nam tu liem", "quan nam tu liem", "ntl"],
            &[],
        ),
        dist(
            "Hà Nội",
            "Bắc Từ Liêm",
            &["bac tu liem", "quan bac tu liem", "btl"],
            &[],
        ),
        dist(
            "Hà Nội",
            "Thanh Xuân",
            &["thanh xuan", "quan thanh xuan", "q.thanh xuan"],
            &["tx"],
        ),
        dist(
            "Hà Nội",
            "Đống Đa",
            &["dong da", "quan dong da", "q.dong da"],
            &["dd"],
        ),
        dist(
            "Hà Nội",
            "Ba Đình",
            &["ba dinh", "quan ba dinh", "q.ba dinh"],
            &[],
        ),
        dist(
            "Hà Nội",
            "Hoàn Kiếm",
            &["hoan kiem", "quan hoan kiem", "pho co"],
            &[],
        ),
        dist(
            "Hà Nội",
            "Tây Hồ",
            &["tay ho", "quan tay ho", "ho tay"],
            &[],
        ),
        dist(
            "Hà Nội",
            "Hai Bà Trưng",
            &["hai ba trung", "quan hai ba trung", "hbt"],
            &[],
        ),
        dist(
            "Hà Nội",
            "Hoàng Mai",
            &["hoang mai", "quan hoang mai"],
            &["hm"],
        ),
        dist(
            "Hà Nội",
            "Long Biên",
            &["long bien", "quan long bien"],
            &["lb"],
        ),
        dist("Hà Nội", "Hà Đông", &["ha dong", "quan ha dong"], &[]),
        dist("Hà Nội", "Gia Lâm", &["gia lam", "huyen gia lam"], &[]),
        dist("Hà Nội", "Đông Anh", &["dong anh", "huyen dong anh"], &[]),
        dist(
            "Hà Nội",
            "Thanh Trì",
            &["thanh tri", "huyen thanh tri"],
            &[],
        ),
        dist("Hà Nội", "Hoài Đức", &["hoai duc", "huyen hoai duc"], &[]),
        dist(
            "Hà Nội",
            "Đan Phượng",
            &["dan phuong", "huyen dan phuong"],
            &[],
        ),
        dist("Hà Nội", "Sóc Sơn", &["soc son", "huyen soc son"], &[]),
        dist("Hà Nội", "Mê Linh", &["me linh", "huyen me linh"], &[]),
        dist(
            "Hà Nội",
            "Thạch Thất",
            &["thach that", "huyen thach that", "hoa lac"],
            &[],
        ),
        dist("Hà Nội", "Quốc Oai", &["quoc oai", "huyen quoc oai"], &[]),
        dist(
            "Hà Nội",
            "Chương Mỹ",
            &["chuong my", "huyen chuong my"],
            &[],
        ),
        dist(
            "Hà Nội",
            "Thanh Oai",
            &["thanh oai", "huyen thanh oai"],
            &[],
        ),
        dist(
            "Hà Nội",
            "Thường Tín",
            &["thuong tin", "huyen thuong tin"],
            &[],
        ),
        dist(
            "Hà Nội",
            "Phú Xuyên",
            &["phu xuyen", "huyen phu xuyen"],
            &[],
        ),
        dist("Hà Nội", "Ứng Hoà", &["ung hoa", "huyen ung hoa"], &[]),
        dist("Hà Nội", "Mỹ Đức", &["my duc", "huyen my duc"], &[]),
        dist("Hà Nội", "Ba Vì", &["ba vi", "huyen ba vi"], &[]),
        dist("Hà Nội", "Phúc Thọ", &["phuc tho", "huyen phuc tho"], &[]),
        dist(
            "Hà Nội",
            "Sơn Tây",
            &["son tay", "thi xa son tay", "tx son tay"],
            &[],
        ),
        // Hà Nội — Major Wards & Urban Areas
        ward(
            "Hà Nội",
            "Cầu Giấy",
            "Dịch Vọng",
            &["dich vong", "phuong dich vong"],
        ),
        ward(
            "Hà Nội",
            "Cầu Giấy",
            "Dịch Vọng Hậu",
            &["dich vong hau", "duy tan", "tran thai tong", "xuan thuy"],
        ),
        ward(
            "Hà Nội",
            "Cầu Giấy",
            "Mai Dịch",
            &["mai dich", "phuong mai dich", "ho tung mau"],
        ),
        ward(
            "Hà Nội",
            "Cầu Giấy",
            "Nghĩa Đô",
            &["nghia do", "hoang quoc viet"],
        ),
        ward("Hà Nội", "Cầu Giấy", "Nghĩa Tân", &["nghia tan", "to hieu"]),
        ward(
            "Hà Nội",
            "Cầu Giấy",
            "Quan Hoa",
            &["quan hoa", "nguyen khanh toan"],
        ),
        ward(
            "Hà Nội",
            "Cầu Giấy",
            "Trung Hoà",
            &["trung hoa", "trung hoa nhan chinh", "tran duy hung"],
        ),
        ward("Hà Nội", "Cầu Giấy", "Yên Hoà", &["yen hoa", "trung kinh"]),
        ward(
            "Hà Nội",
            "Nam Từ Liêm",
            "Mỹ Đình 1",
            &["my dinh", "my dinh 1"],
        ),
        ward(
            "Hà Nội",
            "Nam Từ Liêm",
            "Mỹ Đình 2",
            &["my dinh 2", "le duc tho", "ham nghi"],
        ),
        ward(
            "Hà Nội",
            "Nam Từ Liêm",
            "Mễ Trì",
            &["me tri", "keangnam", "the manor"],
        ),
        ward(
            "Hà Nội",
            "Nam Từ Liêm",
            "Tây Mỗ",
            &["tay mo", "vinhomes smart city", "smart city"],
        ),
        ward("Hà Nội", "Nam Từ Liêm", "Đại Mỗ", &["dai mo"]),
        ward(
            "Hà Nội",
            "Nam Từ Liêm",
            "Trung Văn",
            &["trung van", "to huu"],
        ),
        ward("Hà Nội", "Nam Từ Liêm", "Phú Đô", &["phu do"]),
        ward("Hà Nội", "Nam Từ Liêm", "Cầu Diễn", &["cau dien"]),
        ward("Hà Nội", "Nam Từ Liêm", "Xuân Phương", &["xuan phuong"]),
        ward("Hà Nội", "Nam Từ Liêm", "Phương Canh", &["phuong canh"]),
        ward(
            "Hà Nội",
            "Bắc Từ Liêm",
            "Cổ Nhuế 1",
            &["co nhue", "co nhue 1", "co nhue 2", "thanh pho giao luu"],
        ),
        ward(
            "Hà Nội",
            "Bắc Từ Liêm",
            "Xuân Đỉnh",
            &["xuan dinh", "ngoai giao doan"],
        ),
        ward("Hà Nội", "Bắc Từ Liêm", "Xuân Tảo", &["xuan tao"]),
        ward("Hà Nội", "Bắc Từ Liêm", "Phú Diễn", &["phu dien"]),
        ward("Hà Nội", "Bắc Từ Liêm", "Đông Ngạc", &["dong ngac"]),
        ward(
            "Hà Nội",
            "Thanh Xuân",
            "Nhân Chính",
            &["nhan chinh", "le van luong"],
        ),
        ward(
            "Hà Nội",
            "Thanh Xuân",
            "Thượng Đình",
            &["thuong dinh", "royal city", "nga tu so"],
        ),
        ward("Hà Nội", "Thanh Xuân", "Khương Trung", &["khuong trung"]),
        ward("Hà Nội", "Thanh Xuân", "Khương Đình", &["khuong dinh"]),
        ward("Hà Nội", "Thanh Xuân", "Khương Mai", &["khuong mai"]),
        ward("Hà Nội", "Thanh Xuân", "Hạ Đình", &["ha dinh"]),
        ward("Hà Nội", "Thanh Xuân", "Kim Giang", &["kim giang"]),
        ward("Hà Nội", "Thanh Xuân", "Phương Liệt", &["phuong liet"]),
        ward(
            "Hà Nội",
            "Thanh Xuân",
            "Thanh Xuân Trung",
            &["thanh xuan trung", "nguyen tuan", "vu trong phung"],
        ),
        ward(
            "Hà Nội",
            "Đống Đa",
            "Láng Hạ",
            &["lang ha", "huynh thuc khang"],
        ),
        ward(
            "Hà Nội",
            "Đống Đa",
            "Láng Thượng",
            &["lang thuong", "chua lang", "duong lang"],
        ),
        ward(
            "Hà Nội",
            "Đống Đa",
            "Ô Chợ Dừa",
            &["o cho dua", "hoang cau"],
        ),
        ward(
            "Hà Nội",
            "Đống Đa",
            "Trung Liệt",
            &["trung liet", "thai ha", "chua boc", "tay son"],
        ),
        ward("Hà Nội", "Đống Đa", "Phương Mai", &["phuong mai"]),
        ward(
            "Hà Nội",
            "Đống Đa",
            "Kim Liên",
            &["kim lien", "pham ngoc thach"],
        ),
        ward("Hà Nội", "Đống Đa", "Khâm Thiên", &["kham thien"]),
        ward("Hà Nội", "Đống Đa", "Cát Linh", &["cat linh"]),
        ward("Hà Nội", "Ba Đình", "Giảng Võ", &["giang vo"]),
        ward("Hà Nội", "Ba Đình", "Kim Mã", &["kim ma"]),
        ward(
            "Hà Nội",
            "Ba Đình",
            "Liễu Giai",
            &["lieu giai", "dao tan", "van cao"],
        ),
        ward("Hà Nội", "Ba Đình", "Đội Cấn", &["doi can"]),
        ward("Hà Nội", "Ba Đình", "Ngọc Khánh", &["ngoc khanh"]),
        ward("Hà Nội", "Ba Đình", "Thành Công", &["thanh cong"]),
        ward("Hà Nội", "Tây Hồ", "Xuân La", &["xuan la", "vo chi cong"]),
        ward("Hà Nội", "Tây Hồ", "Phú Thượng", &["phu thuong", "ciputra"]),
        ward(
            "Hà Nội",
            "Tây Hồ",
            "Quảng An",
            &["quang an", "to ngoc van", "xuan dieu"],
        ),
        ward("Hà Nội", "Tây Hồ", "Thuỵ Khuê", &["thuy khue"]),
        ward("Hà Nội", "Tây Hồ", "Bưởi", &["phuong buoi", "trich sai"]),
        ward(
            "Hà Nội",
            "Hai Bà Trưng",
            "Vĩnh Tuy",
            &["vinh tuy", "times city"],
        ),
        ward("Hà Nội", "Hai Bà Trưng", "Minh Khai", &["minh khai"]),
        ward(
            "Hà Nội",
            "Hai Bà Trưng",
            "Bách Khoa",
            &["bach khoa", "ta quang buu"],
        ),
        ward("Hà Nội", "Hai Bà Trưng", "Bạch Mai", &["bach mai"]),
        ward("Hà Nội", "Hai Bà Trưng", "Trương Định", &["truong dinh"]),
        ward(
            "Hà Nội",
            "Hoàng Mai",
            "Hoàng Liệt",
            &["hoang liet", "linh dam"],
        ),
        ward("Hà Nội", "Hoàng Mai", "Định Công", &["dinh cong"]),
        ward(
            "Hà Nội",
            "Hoàng Mai",
            "Đại Kim",
            &["dai kim", "kim van kim lu"],
        ),
        ward("Hà Nội", "Hoàng Mai", "Tân Mai", &["tan mai"]),
        ward("Hà Nội", "Hoàng Mai", "Yên Sở", &["yen so", "gamuda"]),
        ward("Hà Nội", "Long Biên", "Bồ Đề", &["bo de"]),
        ward("Hà Nội", "Long Biên", "Ngọc Thuỵ", &["ngoc thuy"]),
        ward(
            "Hà Nội",
            "Long Biên",
            "Việt Hưng",
            &["viet hung", "vinhomes riverside"],
        ),
        ward("Hà Nội", "Long Biên", "Sài Đồng", &["sai dong"]),
        ward("Hà Nội", "Long Biên", "Thạch Bàn", &["thach ban"]),
        ward("Hà Nội", "Hà Đông", "Mộ Lao", &["mo lao", "lang viet kieu"]),
        ward("Hà Nội", "Hà Đông", "Văn Quán", &["van quan"]),
        ward("Hà Nội", "Hà Đông", "Dương Nội", &["duong noi"]),
        ward("Hà Nội", "Hà Đông", "La Khê", &["la khe", "van khe"]),
        ward("Hà Nội", "Hà Đông", "Phúc La", &["phuc la", "xa la"]),
        ward("Hà Nội", "Hà Đông", "Vạn Phúc", &["van phuc"]),
        ward(
            "Hà Nội",
            "Gia Lâm",
            "Đa Tốn",
            &["da ton", "vinhomes ocean park", "ocean park"],
        ),
        ward("Hà Nội", "Gia Lâm", "Trâu Quỳ", &["trau quy"]),
        // ======================== TP. HỒ CHÍ MINH — ALL DISTRICTS ========================
        dist(
            "TP. Hồ Chí Minh",
            "Quận 1",
            &["quan 1", "q.1", "q 1", "q1"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Quận 2",
            &["quan 2", "q.2", "q 2", "q2"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Quận 3",
            &["quan 3", "q.3", "q 3", "q3"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Quận 4",
            &["quan 4", "q.4", "q 4", "q4"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Quận 5",
            &["quan 5", "q.5", "q 5", "q5"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Quận 6",
            &["quan 6", "q.6", "q 6", "q6"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Quận 7",
            &["quan 7", "q.7", "q 7", "q7"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Quận 8",
            &["quan 8", "q.8", "q 8", "q8"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Quận 9",
            &["quan 9", "q.9", "q 9", "q9"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Quận 10",
            &["quan 10", "q.10", "q 10", "q10"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Quận 11",
            &["quan 11", "q.11", "q 11", "q11"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Quận 12",
            &["quan 12", "q.12", "q 12", "q12"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Thủ Đức",
            &[
                "tp thu duc",
                "thanh pho thu duc",
                "thu duc",
                "q.thu duc",
                "tptd",
            ],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Bình Thạnh",
            &[
                "binh thanh",
                "quan binh thanh",
                "q.binh thanh",
                "q.bt",
                "qbt",
            ],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Gò Vấp",
            &["go vap", "quan go vap", "q.go vap", "q.gv", "qgv"],
            &["gv"],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Phú Nhuận",
            &["phu nhuan", "quan phu nhuan", "q.phu nhuan", "q.pn", "qpn"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Tân Bình",
            &["tan binh", "quan tan binh", "q.tan binh", "q.tb", "qtb"],
            &["tb"],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Tân Phú",
            &["tan phu", "quan tan phu", "q.tan phu", "q.tp"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Bình Tân",
            &["binh tan", "quan binh tan", "q.binh tan", "btan"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Bình Chánh",
            &["binh chanh", "huyen binh chanh"],
            &["bc"],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Nhà Bè",
            &["nha be", "huyen nha be"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Hóc Môn",
            &["hoc mon", "huyen hoc mon"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Củ Chi",
            &["cu chi", "huyen cu chi"],
            &[],
        ),
        dist(
            "TP. Hồ Chí Minh",
            "Cần Giờ",
            &["can gio", "huyen can gio"],
            &[],
        ),
        // TP.HCM — Major Wards & Urban Areas
        ward("TP. Hồ Chí Minh", "Quận 1", "Bến Nghé", &["ben nghe"]),
        ward("TP. Hồ Chí Minh", "Quận 1", "Bến Thành", &["ben thanh"]),
        ward("TP. Hồ Chí Minh", "Quận 1", "Đa Kao", &["da kao", "dakao"]),
        ward("TP. Hồ Chí Minh", "Quận 1", "Tân Định", &["tan dinh"]),
        ward(
            "TP. Hồ Chí Minh",
            "Thủ Đức",
            "Thảo Điền",
            &["thao dien", "phuong thao dien"],
        ),
        ward(
            "TP. Hồ Chí Minh",
            "Thủ Đức",
            "An Phú",
            &["an phu", "an khanh"],
        ),
        ward(
            "TP. Hồ Chí Minh",
            "Thủ Đức",
            "Thủ Thiêm",
            &["thu thiem", "sala"],
        ),
        ward(
            "TP. Hồ Chí Minh",
            "Thủ Đức",
            "Thạnh Mỹ Lợi",
            &["thanh my loi"],
        ),
        ward(
            "TP. Hồ Chí Minh",
            "Thủ Đức",
            "Hiệp Bình Chánh",
            &["hiep binh chanh", "pham van dong"],
        ),
        ward(
            "TP. Hồ Chí Minh",
            "Thủ Đức",
            "Linh Trung",
            &["linh trung", "linh chieu", "linh dong", "linh tay"],
        ),
        ward(
            "TP. Hồ Chí Minh",
            "Thủ Đức",
            "Long Thạnh Mỹ",
            &["long thanh my", "vinhomes grand park"],
        ),
        ward(
            "TP. Hồ Chí Minh",
            "Quận 7",
            "Tân Phong",
            &["tan phong", "phu my hung"],
        ),
        ward(
            "TP. Hồ Chí Minh",
            "Quận 7",
            "Tân Hưng",
            &["tan hung", "sunrise city"],
        ),
        ward(
            "TP. Hồ Chí Minh",
            "Quận 7",
            "Tân Thuận Đông",
            &["tan thuan", "tan quy"],
        ),
        ward(
            "TP. Hồ Chí Minh",
            "Bình Thạnh",
            "Phường 22",
            &["vinhomes central park", "landmark 81", "tan cang"],
        ),
        ward(
            "TP. Hồ Chí Minh",
            "Bình Thạnh",
            "Phường 19",
            &["pham viet chanh", "hang xanh"],
        ),
        ward(
            "TP. Hồ Chí Minh",
            "Bình Chánh",
            "Bình Hưng",
            &["trung son", "kdc trung son"],
        ),
        // ======================== ĐÀ NẴNG ========================
        dist("Đà Nẵng", "Hải Châu", &["hai chau", "quan hai chau"], &[]),
        dist(
            "Đà Nẵng",
            "Sơn Trà",
            &["son tra", "quan son tra", "phuoc my", "an thuong"],
            &[],
        ),
        dist(
            "Đà Nẵng",
            "Ngũ Hành Sơn",
            &["ngu hanh son", "quan ngu hanh son", "my an"],
            &[],
        ),
        dist(
            "Đà Nẵng",
            "Thanh Khê",
            &["thanh khe", "quan thanh khe"],
            &[],
        ),
        dist(
            "Đà Nẵng",
            "Liên Chiểu",
            &["lien chieu", "quan lien chieu", "hoa khanh"],
            &[],
        ),
        dist(
            "Đà Nẵng",
            "Cẩm Lệ",
            &["cam le", "quan cam le", "hoa xuan"],
            &[],
        ),
        dist("Đà Nẵng", "Hoà Vang", &["hoa vang", "huyen hoa vang"], &[]),
        // ======================== HẢI PHÒNG ========================
        dist(
            "Hải Phòng",
            "Ngô Quyền",
            &["ngo quyen", "quan ngo quyen", "van cao hai phong"],
            &[],
        ),
        dist("Hải Phòng", "Lê Chân", &["le chan", "quan le chan"], &[]),
        dist(
            "Hải Phòng",
            "Hồng Bàng",
            &["hong bang", "quan hong bang"],
            &[],
        ),
        dist("Hải Phòng", "Hải An", &["hai an", "quan hai an"], &[]),
        dist("Hải Phòng", "Kiến An", &["kien an", "quan kien an"], &[]),
        dist("Hải Phòng", "Đồ Sơn", &["do son", "quan do son"], &[]),
        dist(
            "Hải Phòng",
            "Dương Kinh",
            &["duong kinh", "quan duong kinh"],
            &[],
        ),
        dist(
            "Hải Phòng",
            "Thuỷ Nguyên",
            &["thuy nguyen", "tp thuy nguyen"],
            &[],
        ),
        dist("Hải Phòng", "An Dương", &["an duong", "quan an duong"], &[]),
        dist("Hải Phòng", "Cát Hải", &["cat hai", "cat ba"], &[]),
        // ======================== CẦN THƠ ========================
        dist(
            "Cần Thơ",
            "Ninh Kiều",
            &["ninh kieu", "quan ninh kieu"],
            &[],
        ),
        dist("Cần Thơ", "Cái Răng", &["cai rang", "quan cai rang"], &[]),
        dist(
            "Cần Thơ",
            "Bình Thuỷ",
            &["binh thuy", "quan binh thuy"],
            &[],
        ),
        dist("Cần Thơ", "Ô Môn", &["o mon", "quan o mon"], &[]),
        dist("Cần Thơ", "Thốt Nốt", &["thot not", "quan thot not"], &[]),
        // ======================== BÌNH DƯƠNG, ĐỒNG NAI, BR-VT, KHÁNH HOÀ, BẮC NINH, HƯNG YÊN, QUẢNG NINH ========================
        dist(
            "Bình Dương",
            "Thủ Dầu Một",
            &["thu dau mot", "tp thu dau mot", "tdm"],
            &[],
        ),
        dist(
            "Bình Dương",
            "Dĩ An",
            &["di an", "tp di an", "dong hoa"],
            &[],
        ),
        dist(
            "Bình Dương",
            "Thuận An",
            &["thuan an", "tp thuan an", "lai thieu"],
            &[],
        ),
        dist("Bình Dương", "Bến Cát", &["ben cat", "tp ben cat"], &[]),
        dist("Bình Dương", "Tân Uyên", &["tan uyen", "tp tan uyen"], &[]),
        dist("Đồng Nai", "Biên Hoà", &["bien hoa", "tp bien hoa"], &[]),
        dist(
            "Đồng Nai",
            "Long Thành",
            &["long thanh", "huyen long thanh"],
            &[],
        ),
        dist(
            "Đồng Nai",
            "Nhơn Trạch",
            &["nhon trach", "huyen nhon trach"],
            &[],
        ),
        dist(
            "Đồng Nai",
            "Long Khánh",
            &["long khanh", "tp long khanh"],
            &[],
        ),
        dist(
            "Đồng Nai",
            "Trảng Bom",
            &["trang bom", "huyen trang bom"],
            &[],
        ),
        dist(
            "Bà Rịa - Vũng Tàu",
            "Vũng Tàu",
            &["vung tau", "tp vung tau"],
            &[],
        ),
        dist("Bà Rịa - Vũng Tàu", "Bà Rịa", &["tp ba ria"], &[]),
        dist("Bà Rịa - Vũng Tàu", "Phú Mỹ", &["phu my", "tx phu my"], &[]),
        dist(
            "Bà Rịa - Vũng Tàu",
            "Xuyên Mộc",
            &["xuyen moc", "ho tram"],
            &[],
        ),
        dist(
            "Khánh Hoà",
            "Nha Trang",
            &["nha trang", "tp nha trang", "vinh diem trung"],
            &[],
        ),
        dist("Khánh Hoà", "Cam Ranh", &["cam ranh", "tp cam ranh"], &[]),
        dist("Khánh Hoà", "Cam Lâm", &["cam lam", "bai dai"], &[]),
        dist("Khánh Hoà", "Ninh Hoà", &["ninh hoa", "tx ninh hoa"], &[]),
        dist("Bắc Ninh", "TP Bắc Ninh", &["tp bac ninh"], &[]),
        dist("Bắc Ninh", "Từ Sơn", &["tu son", "tp tu son"], &[]),
        dist(
            "Bắc Ninh",
            "Yên Phong",
            &["yen phong", "kcn yen phong"],
            &[],
        ),
        dist("Bắc Ninh", "Quế Võ", &["que vo", "tx que vo"], &[]),
        dist("Bắc Ninh", "Tiên Du", &["tien du"], &[]),
        dist(
            "Bắc Ninh",
            "Thuận Thành",
            &["thuan thanh", "tx thuan thanh"],
            &[],
        ),
        dist(
            "Hưng Yên",
            "Văn Giang",
            &["van giang", "ecopark", "ocean park 2", "ocean park 3"],
            &[],
        ),
        dist("Hưng Yên", "Mỹ Hào", &["my hao", "tx my hao"], &[]),
        dist("Hưng Yên", "Văn Lâm", &["van lam"], &[]),
        dist(
            "Quảng Ninh",
            "Hạ Long",
            &["ha long", "tp ha long", "halong", "bai chay", "hon gai"],
            &[],
        ),
        dist("Quảng Ninh", "Cẩm Phả", &["cam pha", "tp cam pha"], &[]),
        dist("Quảng Ninh", "Uông Bí", &["uong bi", "tp uong bi"], &[]),
        dist("Quảng Ninh", "Móng Cái", &["mong cai", "tp mong cai"], &[]),
        dist(
            "Quảng Ninh",
            "Quảng Yên",
            &["quang yen", "tx quang yen"],
            &[],
        ),
        dist(
            "Quảng Ninh",
            "Đông Triều",
            &["dong trieu", "tp dong trieu"],
            &[],
        ),
    ];

    let mut raw_by_first_word: HashMap<&'static str, Vec<(&'static str, CompiledAlias)>> =
        HashMap::new();
    let mut province_scope_map: HashMap<&'static str, &'static str> = HashMap::new();

    for (entry_idx, entry) in entries.iter().enumerate() {
        if entry.district.is_none() && entry.ward.is_none() {
            for &alias in entry.aliases {
                province_scope_map.insert(alias, entry.province);
            }
            for &short in entry.short_aliases {
                province_scope_map.insert(short, entry.province);
            }
        }
        for &alias in entry.aliases {
            let first_end = scan_alnum_end(alias, 0);
            if first_end > 0 {
                let first = &alias[..first_end];
                let next_byte = alias.as_bytes().get(first_end + 1).copied().unwrap_or(0);
                raw_by_first_word.entry(first).or_default().push((
                    alias,
                    CompiledAlias {
                        entry_idx,
                        is_short: false,
                        next_byte,
                    },
                ));
            }
        }
        for &short in entry.short_aliases {
            let first_end = scan_alnum_end(short, 0);
            if first_end > 0 {
                let first = &short[..first_end];
                let next_byte = short.as_bytes().get(first_end + 1).copied().unwrap_or(0);
                raw_by_first_word.entry(first).or_default().push((
                    short,
                    CompiledAlias {
                        entry_idx,
                        is_short: true,
                        next_byte,
                    },
                ));
            }
        }
    }

    let mut first_word_mask = [0u64; 256];
    let mut by_first_word: FastStaticWordMap<FirstWordBucket> =
        FastStaticWordMap::with_capacity(raw_by_first_word.len());
    for (word, mut list) in raw_by_first_word {
        if let Some(&b0) = word.as_bytes().first() {
            first_word_mask[b0 as usize] |= 1u64 << word.len().min(63);
        }
        list.sort_by(|a, b| {
            b.0.len()
                .cmp(&a.0.len())
                .then_with(|| a.1.is_short.cmp(&b.1.is_short))
        });
        let mut has_short_phrase = false;
        let mut next_byte_mask = 0u128;
        for &(_, meta) in &list {
            if meta.next_byte == 0 {
                has_short_phrase = true;
            } else if meta.next_byte < 128 {
                next_byte_mask |= 1u128 << meta.next_byte;
            }
        }
        by_first_word.insert(
            word,
            FirstWordBucket {
                has_short_phrase,
                next_byte_mask,
                items: list,
            },
        );
    }

    GazetteerIndex {
        entries,
        first_word_mask,
        by_first_word,
        province_scope_map,
    }
}
