use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;
use whatlang::Lang;

/// Minimum `text_norm` length in characters to apply SimHash near-dedup (`05-pipeline-rules.md §4`).
pub const NEAR_DUP_MIN_CHARS: usize = 80;
/// Maximum Hamming distance between two 64-bit SimHashes for near-dedup (`05-pipeline-rules.md §4`).
pub const NEAR_DUP_MAX_HAMMING: u32 = 3;
/// Minimum character length for language detection (`05-pipeline-rules.md §3`).
pub const LANG_DETECT_MIN_CHARS: usize = 20;
/// Dedup lookback window in milliseconds (14 days, `05-pipeline-rules.md §4`).
pub const DEDUP_WINDOW_MS: i64 = 14 * 86_400_000;
/// Intentional repost threshold in milliseconds (72 hours, `05-pipeline-rules.md §4`).
pub const REPOST_ALLOW_AFTER_MS: i64 = 72 * 3_600_000;

/// T1 normalized text artifacts for a post (`05-pipeline-rules.md §3`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NormalizedText {
    pub text_norm: String,
    pub text_fold: String,
    pub lang: String,
    pub content_hash: String,
    /// Signed 64-bit two's-complement representation for SQLite `INTEGER` storage.
    pub simhash: i64,
    /// Four 16-bit bands of `simhash` (little-endian band order `[b0, b1, b2, b3]`) for LSH lookup.
    pub simhash_bands: [u16; 4],
}

impl NormalizedText {
    /// Unsigned 64-bit representation of [`Self::simhash`].
    #[inline]
    pub const fn simhash_u64(&self) -> u64 {
        u64::from_ne_bytes(self.simhash.to_ne_bytes())
    }
}

/// `text_fold` paired with a byte-accurate map back to `text_norm` spans.
///
/// Used by built-in extractors so searches on `text_fold` yield exact `raw` substrings
/// and UTF-8 byte offsets `(start, end)` in `text_norm`.
#[derive(Debug, Clone)]
pub struct FoldedText {
    pub text_fold: String,
    /// For each byte index in `text_fold`, stores `(norm_byte_start, norm_byte_end)` in `text_norm`.
    norm_spans: Vec<(usize, usize)>,
}

impl FoldedText {
    /// Map a byte range `[fold_start..fold_end]` in `self.text_fold` back to `(norm_start, norm_end)`
    /// in `text_norm`, trimming leading/trailing spaces inside the range.
    pub fn map_span(&self, mut fold_start: usize, mut fold_end: usize) -> Option<(usize, usize)> {
        if fold_start >= fold_end || fold_end > self.text_fold.len() {
            return None;
        }
        let bytes = self.text_fold.as_bytes();
        while fold_start < fold_end && bytes[fold_start] == b' ' {
            fold_start += 1;
        }
        while fold_end > fold_start && bytes[fold_end - 1] == b' ' {
            fold_end -= 1;
        }
        if fold_start >= fold_end {
            return None;
        }
        let start = self.norm_spans.get(fold_start)?.0;
        let end = self.norm_spans.get(fold_end - 1)?.1;
        if start <= end {
            Some((start, end))
        } else {
            None
        }
    }

    pub(crate) fn as_view<'a>(&'a self, text_norm: &'a str) -> FoldedView<'a> {
        FoldedView {
            text_fold: &self.text_fold,
            text_norm,
            eager: Some(self),
            lazy: std::cell::RefCell::new(IncrementalSpanMapper::new()),
            tokens: std::cell::OnceCell::new(),
        }
    }
}

/// Incremental prefix span mapper so `FoldedView::map_span` only scans `text_norm` up to
/// the matched `fold_end` offset instead of folding an entire 5,000-character post upfront.
struct IncrementalSpanMapper {
    pos: usize,
    prev_space: bool,
    norm_spans: Vec<(usize, usize)>,
    cluster_buf: String,
    emitted: String,
}

impl IncrementalSpanMapper {
    #[inline]
    fn new() -> Self {
        Self {
            pos: 0,
            prev_space: true,
            norm_spans: Vec::new(),
            cluster_buf: String::new(),
            emitted: String::new(),
        }
    }

    fn advance_until(&mut self, text_norm: &str, target_fold_len: usize) {
        if self.norm_spans.len() >= target_fold_len {
            return;
        }
        let bytes = text_norm.as_bytes();
        let len = bytes.len();
        if self.norm_spans.capacity() < target_fold_len {
            self.norm_spans
                .reserve(target_fold_len - self.norm_spans.len());
        }

        while self.pos < len && self.norm_spans.len() < target_fold_len {
            let b = bytes[self.pos];
            if b < 0x80 {
                let next_b = if self.pos + 1 < len {
                    bytes[self.pos + 1]
                } else {
                    0
                };
                if next_b < 0xCC
                    || !text_norm[self.pos + 1..]
                        .chars()
                        .next()
                        .is_some_and(is_combining_mark)
                {
                    let chunk_start = self.pos;
                    self.pos += 1;
                    if b.is_ascii_alphanumeric() || is_kept_fold_punctuation(b as char) {
                        self.norm_spans.push((chunk_start, self.pos));
                        self.prev_space = false;
                    } else if !b.is_ascii_control() && !self.prev_space {
                        self.norm_spans.push((chunk_start, self.pos));
                        self.prev_space = true;
                    }
                    continue;
                }
            }

            let chunk_start = self.pos;
            let first_char = text_norm[self.pos..].chars().next().unwrap();
            let mut chunk_end = chunk_start + first_char.len_utf8();
            let next_b = if chunk_end < len { bytes[chunk_end] } else { 0 };
            let has_trailing_combining = next_b >= 0xCC
                && text_norm[chunk_end..]
                    .chars()
                    .next()
                    .is_some_and(is_combining_mark);

            if !has_trailing_combining && fold_vietnamese_nfc_char(first_char).is_some() {
                self.norm_spans.push((chunk_start, chunk_end));
                self.prev_space = false;
                self.pos = chunk_end;
                continue;
            }

            self.cluster_buf.clear();
            self.cluster_buf.push(first_char);
            while chunk_end < len && bytes[chunk_end] >= 0xCC {
                let next_c = text_norm[chunk_end..].chars().next().unwrap();
                if is_combining_mark(next_c) {
                    self.cluster_buf.push(next_c);
                    chunk_end += next_c.len_utf8();
                } else {
                    break;
                }
            }
            self.pos = chunk_end;

            self.emitted.clear();
            for kc in self.cluster_buf.nfkc() {
                if is_zero_width_or_invisible(kc) || kc.is_control() {
                    continue;
                }
                if let Some(rep) = fold_special_latin(kc) {
                    self.emitted.push_str(rep);
                    continue;
                }
                if let Some(enc) = map_enclosed_decorative_char(kc) {
                    for lc in enc.to_lowercase() {
                        self.emitted.push(lc);
                    }
                    continue;
                }
                for lc in kc.to_lowercase() {
                    if let Some(rep) = fold_special_latin(lc) {
                        self.emitted.push_str(rep);
                    } else {
                        for dc in std::iter::once(lc).nfd() {
                            if is_combining_mark(dc) {
                                continue;
                            }
                            if let Some(rep2) = fold_special_latin(dc) {
                                self.emitted.push_str(rep2);
                            } else if dc.is_alphanumeric() || is_kept_fold_punctuation(dc) {
                                self.emitted.push(dc);
                            } else {
                                self.emitted.push(' ');
                            }
                        }
                    }
                }
            }

            for ec in self.emitted.chars() {
                if ec.is_whitespace() {
                    if !self.prev_space {
                        self.norm_spans.push((chunk_start, chunk_end));
                        self.prev_space = true;
                    }
                } else {
                    for _ in 0..ec.len_utf8() {
                        self.norm_spans.push((chunk_start, chunk_end));
                    }
                    self.prev_space = false;
                }
            }
        }
    }
}

/// Cached word and digit-run boundaries over `text_fold`, computed at most once per post
/// and shared across `enum_kw`, `gazetteer`, `vn_money`, `vn_area`, and `number`.
pub(crate) struct FoldedTokens {
    pub(crate) words: Vec<(u32, u32)>,
    pub(crate) digit_starts: Vec<usize>,
}

const IS_ASCII_ALNUM_TABLE: [bool; 256] = {
    let mut t = [false; 256];
    let mut i = 0usize;
    while i < 256 {
        let b = i as u8;
        t[i] = (b >= b'a' && b <= b'z') || (b >= b'A' && b <= b'Z') || (b >= b'0' && b <= b'9');
        i += 1;
    }
    t
};

impl FoldedTokens {
    fn build(tf: &str) -> Self {
        let bytes = tf.as_bytes();
        let len = bytes.len();
        if len == 0 {
            return Self {
                words: Vec::new(),
                digit_starts: Vec::new(),
            };
        }
        let est_words = (len / 5).max(8);
        let mut words = Vec::with_capacity(est_words);
        let mut digit_starts = Vec::new();

        if tf.is_ascii() {
            let mut tok_start = 0usize;
            for tok in tf.split(' ') {
                let tok_end = tok_start + tok.len();
                let mut pos = tok_start;
                while pos < tok_end {
                    let b0 = bytes[pos];
                    if !IS_ASCII_ALNUM_TABLE[b0 as usize] {
                        pos += 1;
                        continue;
                    }
                    let w_start = pos;
                    pos += 1;
                    while pos < tok_end && IS_ASCII_ALNUM_TABLE[bytes[pos] as usize] {
                        pos += 1;
                    }
                    words.push((w_start as u32, pos as u32));
                    if b0.wrapping_sub(b'0') < 10 {
                        digit_starts.push(w_start);
                    }
                }
                tok_start = tok_end + 1;
            }
        } else {
            let mut pos = 0usize;
            while pos < len {
                let b0 = bytes[pos];
                if b0 < 0x80 {
                    if !IS_ASCII_ALNUM_TABLE[b0 as usize] {
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
                let w_start = pos;
                if b0 < 0x80 && b0.wrapping_sub(b'0') < 10 {
                    digit_starts.push(w_start);
                }
                while pos < len {
                    let b = bytes[pos];
                    if b < 0x80 {
                        if IS_ASCII_ALNUM_TABLE[b as usize] {
                            pos += 1;
                        } else {
                            break;
                        }
                    } else {
                        let ch = tf[pos..].chars().next().unwrap();
                        if ch.is_alphanumeric() {
                            pos += ch.len_utf8();
                        } else {
                            break;
                        }
                    }
                }
                words.push((w_start as u32, pos as u32));
            }
        }

        Self {
            words,
            digit_starts,
        }
    }
}

/// Borrowed view over `text_fold` that computes byte-span mappings into `text_norm` lazily
/// and incrementally up to `fold_end` only when an extractor actually produces a match.
pub(crate) struct FoldedView<'a> {
    pub(crate) text_fold: &'a str,
    text_norm: &'a str,
    eager: Option<&'a FoldedText>,
    lazy: std::cell::RefCell<IncrementalSpanMapper>,
    tokens: std::cell::OnceCell<FoldedTokens>,
}

impl<'a> FoldedView<'a> {
    #[inline]
    pub(crate) fn lazy(text_norm: &'a str, text_fold: &'a str) -> Self {
        Self {
            text_fold,
            text_norm,
            eager: None,
            lazy: std::cell::RefCell::new(IncrementalSpanMapper::new()),
            tokens: std::cell::OnceCell::new(),
        }
    }

    /// Cached maximal alphanumeric word spans `(start, end)` in `self.text_fold`.
    #[inline]
    pub(crate) fn words(&self) -> &[(u32, u32)] {
        &self
            .tokens
            .get_or_init(|| FoldedTokens::build(self.text_fold))
            .words
    }

    /// Cached byte offsets of word-starting ASCII digit runs in `self.text_fold`,
    /// shared across `vn_money`, `vn_area`, and `number` so `text_fold` is tokenized only once.
    #[inline]
    pub(crate) fn digit_starts(&self) -> &[usize] {
        &self
            .tokens
            .get_or_init(|| FoldedTokens::build(self.text_fold))
            .digit_starts
    }

    #[inline]
    pub(crate) fn map_span(
        &self,
        mut fold_start: usize,
        mut fold_end: usize,
    ) -> Option<(usize, usize)> {
        if let Some(ft) = self.eager {
            return ft.map_span(fold_start, fold_end);
        }
        if fold_start >= fold_end || fold_end > self.text_fold.len() {
            return None;
        }
        let bytes = self.text_fold.as_bytes();
        while fold_start < fold_end && bytes[fold_start] == b' ' {
            fold_start += 1;
        }
        while fold_end > fold_start && bytes[fold_end - 1] == b' ' {
            fold_end -= 1;
        }
        if fold_start >= fold_end {
            return None;
        }
        let mut mapper = self.lazy.borrow_mut();
        mapper.advance_until(self.text_norm, fold_end);
        let start = mapper.norm_spans.get(fold_start)?.0;
        let end = mapper.norm_spans.get(fold_end - 1)?.1;
        if start <= end {
            Some((start, end))
        } else {
            None
        }
    }
}

/// Run full T1 normalization on raw post text (`05-pipeline-rules.md §3`).
pub fn normalize_text(raw: &str) -> NormalizedText {
    let text_norm = normalize_nfc_clean(raw);
    let folded = fold_with_spans(&text_norm);
    let text_fold = folded.text_fold;
    let lang = detect_lang(&text_norm);
    let content_hash = compute_content_hash(&text_fold);
    let simhash_u64 = compute_simhash(&text_fold);
    let simhash = simhash_to_i64(simhash_u64);
    let simhash_bands = simhash_bands(simhash_u64);

    NormalizedText {
        text_norm,
        text_fold,
        lang,
        content_hash,
        simhash,
        simhash_bands,
    }
}

/// Convert a `u64` SimHash to `i64` for SQLite `INTEGER` storage (`i64::from_ne_bytes`).
#[inline]
pub const fn simhash_to_i64(simhash: u64) -> i64 {
    i64::from_ne_bytes(simhash.to_ne_bytes())
}

/// Convert a stored SQLite `i64` SimHash back to `u64`.
#[inline]
pub const fn simhash_from_i64(simhash: i64) -> u64 {
    u64::from_ne_bytes(simhash.to_ne_bytes())
}

/// Split a 64-bit SimHash into four 16-bit bands (`05-pipeline-rules.md §4`).
///
/// By the pigeonhole principle, any two SimHashes with Hamming distance `<= 3`
/// share at least one identical 16-bit band.
#[inline]
pub const fn simhash_bands(simhash: u64) -> [u16; 4] {
    [
        (simhash & 0xFFFF) as u16,
        ((simhash >> 16) & 0xFFFF) as u16,
        ((simhash >> 32) & 0xFFFF) as u16,
        ((simhash >> 48) & 0xFFFF) as u16,
    ]
}

/// Split a signed `i64` SimHash into four 16-bit bands.
#[inline]
pub const fn simhash_bands_i64(simhash: i64) -> [u16; 4] {
    simhash_bands(simhash_from_i64(simhash))
}

/// Compute Hamming distance between two `u64` SimHashes.
#[inline]
pub const fn hamming_distance(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

/// Compute Hamming distance between two `i64` SimHashes.
#[inline]
pub const fn hamming_distance_i64(a: i64, b: i64) -> u32 {
    hamming_distance(simhash_from_i64(a), simhash_from_i64(b))
}

/// Check T2 near-duplicate condition (`05-pipeline-rules.md §4`):
/// both posts must be at least 80 characters long and have SimHash Hamming distance `<= 3`.
#[inline]
pub fn is_near_duplicate(
    len_a_chars: usize,
    simhash_a: u64,
    len_b_chars: usize,
    simhash_b: u64,
) -> bool {
    len_a_chars >= NEAR_DUP_MIN_CHARS
        && len_b_chars >= NEAR_DUP_MIN_CHARS
        && hamming_distance(simhash_a, simhash_b) <= NEAR_DUP_MAX_HAMMING
}

#[inline]
fn is_zero_width_or_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}' // soft hyphen
        | '\u{034F}' // combining grapheme joiner
        | '\u{061C}' // Arabic letter mark
        | '\u{180E}' // Mongolian vowel separator
        | '\u{200B}'..='\u{200F}' // ZWSP, ZWNJ, ZWJ, LRM, RLM
        | '\u{202A}'..='\u{202E}' // bidi embedding/override
        | '\u{2060}'..='\u{206F}' // word joiner & invisible operators
        | '\u{20DD}'..='\u{20E4}' // combining enclosing circle/square/keycap
        | '\u{FE00}'..='\u{FE0F}' // variation selectors
        | '\u{FEFF}' // BOM / ZWNBSP
        | '\u{E0100}'..='\u{E01EF}' // variation selectors supplement
    )
}

#[inline]
fn map_enclosed_decorative_char(c: char) -> Option<char> {
    let cp = c as u32;
    if (0x1F130..=0x1F149).contains(&cp) {
        // Squared Latin Capital Letters 🄰..🅉
        char::from_u32(b'A' as u32 + (cp - 0x1F130))
    } else if (0x1F150..=0x1F169).contains(&cp) {
        // Negative Circled Latin Capital Letters 🅐..🅩
        char::from_u32(b'A' as u32 + (cp - 0x1F150))
    } else if (0x1F170..=0x1F189).contains(&cp) {
        // Negative Squared Latin Capital Letters 🅰..🆉
        char::from_u32(b'A' as u32 + (cp - 0x1F170))
    } else {
        None
    }
}

#[inline]
fn needs_decorative_nfkc(c: char) -> bool {
    let cp = c as u32;
    // Mathematical Alphanumeric Symbols (bold, italic, script, fraktur, sans, mono),
    // Halfwidth and Fullwidth ASCII variants, Circled Latin letters, and Letterlike math letters.
    (0x1D400..=0x1D7FF).contains(&cp)
        || (0xFF01..=0xFF5E).contains(&cp)
        || (0x24B6..=0x24E9).contains(&cp)
        || matches!(
            cp,
            0x2102
                | 0x210A..=0x2113
                | 0x2115
                | 0x2119..=0x211D
                | 0x2124
                | 0x212C
                | 0x212F..=0x2131
                | 0x2133..=0x2134
        )
}

/// Produce `text_norm` (`05-pipeline-rules.md §3`):
/// - Strip zero-width & non-whitespace control characters
/// - Convert decorative/mathematical bold/italic/fullwidth/enclosed characters via NFKC
/// - Normalize Vietnamese text to clean Unicode NFC
/// - Collapse all runs of whitespace into a single ASCII `' '` and trim.
pub fn normalize_nfc_clean(raw: &str) -> String {
    let mut pre = String::with_capacity(raw.len());
    for c in raw.chars() {
        if is_zero_width_or_invisible(c) {
            continue;
        }
        if c.is_whitespace() {
            pre.push(' ');
            continue;
        }
        if c.is_control() {
            continue;
        }
        if let Some(mapped) = map_enclosed_decorative_char(c) {
            pre.push(mapped);
            continue;
        }
        if needs_decorative_nfkc(c) {
            for kc in std::iter::once(c).nfkc() {
                if !is_zero_width_or_invisible(kc) && !kc.is_control() {
                    pre.push(if kc.is_whitespace() { ' ' } else { kc });
                }
            }
        } else {
            pre.push(c);
        }
    }

    // Collapse spaced-out decorative sequences? Wait: only collapse whitespace runs
    // after NFC composition so combining diacritics attach to their preceding base character!
    let mut out = String::with_capacity(pre.len());
    let mut prev_space = true; // trims leading spaces
    for c in pre.nfc() {
        if c.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(c);
            prev_space = false;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

#[inline(always)]
fn is_combining_mark(c: char) -> bool {
    matches!(
        c as u32,
        0x0300..=0x036F | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0xFE20..=0xFE2F
    )
}

#[inline]
fn fold_special_latin(c: char) -> Option<&'static str> {
    match c {
        'đ' | 'Đ' | 'ð' | 'Ð' => Some("d"),
        '₫' => Some("d"),
        'ł' | 'Ł' => Some("l"),
        'ø' | 'Ø' => Some("o"),
        'ß' => Some("ss"),
        'æ' | 'Æ' => Some("ae"),
        'œ' | 'Œ' => Some("oe"),
        '–' | '—' | '−' | '‒' | '―' => Some("-"),
        '×' => Some("x"),
        '’' | '‘' => Some("'"),
        '“' | '”' => Some("\""),
        _ => None,
    }
}

#[inline]
fn is_kept_fold_punctuation(c: char) -> bool {
    matches!(
        c,
        '.' | ','
            | '-'
            | '/'
            | '+'
            | ':'
            | ';'
            | '('
            | ')'
            | '%'
            | '\''
            | '"'
            | '?'
            | '!'
            | '@'
            | '#'
            | '&'
            | '='
            | '_'
    )
}

#[inline(always)]
fn fold_vietnamese_nfc_char(c: char) -> Option<u8> {
    match c {
        'à' | 'á' | 'ả' | 'ã' | 'ạ' | 'ă' | 'ằ' | 'ắ' | 'ẳ' | 'ẵ' | 'ặ' | 'â' | 'ầ' | 'ấ' | 'ẩ'
        | 'ẫ' | 'ậ' | 'À' | 'Á' | 'Ả' | 'Ã' | 'Ạ' | 'Ă' | 'Ằ' | 'Ắ' | 'Ẳ' | 'Ẵ' | 'Ặ' | 'Â'
        | 'Ầ' | 'Ấ' | 'Ẩ' | 'Ẫ' | 'Ậ' => Some(b'a'),
        'đ' | 'Đ' => Some(b'd'),
        'è' | 'é' | 'ẻ' | 'ẽ' | 'ẹ' | 'ê' | 'ề' | 'ế' | 'ể' | 'ễ' | 'ệ' | 'È' | 'É' | 'Ẻ' | 'Ẽ'
        | 'Ẹ' | 'Ê' | 'Ề' | 'Ế' | 'Ể' | 'Ễ' | 'Ệ' => Some(b'e'),
        'ì' | 'í' | 'ỉ' | 'ĩ' | 'ị' | 'Ì' | 'Í' | 'Ỉ' | 'Ĩ' | 'Ị' => Some(b'i'),
        'ò' | 'ó' | 'ỏ' | 'õ' | 'ọ' | 'ô' | 'ồ' | 'ố' | 'ổ' | 'ỗ' | 'ộ' | 'ơ' | 'ờ' | 'ớ' | 'ở'
        | 'ỡ' | 'ợ' | 'Ò' | 'Ó' | 'Ỏ' | 'Õ' | 'Ọ' | 'Ô' | 'Ồ' | 'Ố' | 'Ổ' | 'Ỗ' | 'Ộ' | 'Ơ'
        | 'Ờ' | 'Ớ' | 'Ở' | 'Ỡ' | 'Ợ' => Some(b'o'),
        'ù' | 'ú' | 'ủ' | 'ũ' | 'ụ' | 'ư' | 'ừ' | 'ứ' | 'ử' | 'ữ' | 'ự' | 'Ù' | 'Ú' | 'Ủ' | 'Ũ'
        | 'Ụ' | 'Ư' | 'Ừ' | 'Ứ' | 'Ử' | 'Ữ' | 'Ự' => Some(b'u'),
        'ỳ' | 'ý' | 'ỷ' | 'ỹ' | 'ỵ' | 'Ỳ' | 'Ý' | 'Ỷ' | 'Ỹ' | 'Ỵ' => Some(b'y'),
        _ => None,
    }
}

/// Fold arbitrary text into lowercase diacritic-free Vietnamese form (`05-pipeline-rules.md §3`).
pub fn fold_text(input: &str) -> String {
    let norm = normalize_nfc_clean(input);
    fold_with_spans(&norm).text_fold
}

/// Produce `text_fold` from `text_norm` while tracking exact byte spans back into `text_norm`.
pub fn fold_with_spans(text_norm: &str) -> FoldedText {
    let mut text_fold = String::with_capacity(text_norm.len());
    let mut norm_spans: Vec<(usize, usize)> = Vec::with_capacity(text_norm.len());
    let mut prev_space = true;
    let mut cluster_buf = String::with_capacity(16);
    let mut emitted = String::with_capacity(16);

    // Group each base character in `text_norm` with any trailing combining marks so the entire
    // grapheme cluster maps to one contiguous `(chunk_start, chunk_end)` byte range in `text_norm`.
    // Note: all Unicode combining marks (`>= U+0300`) have leading UTF-8 byte `>= 0xCC`.
    let bytes = text_norm.as_bytes();
    let len = bytes.len();
    let mut pos = 0usize;
    while pos < len {
        let b = bytes[pos];
        if b < 0x80 {
            let next_b = if pos + 1 < len { bytes[pos + 1] } else { 0 };
            if next_b < 0xCC
                || !text_norm[pos + 1..]
                    .chars()
                    .next()
                    .is_some_and(is_combining_mark)
            {
                let chunk_start = pos;
                pos += 1;
                if b.is_ascii_alphanumeric() {
                    text_fold.push(b.to_ascii_lowercase() as char);
                    norm_spans.push((chunk_start, pos));
                    prev_space = false;
                } else if is_kept_fold_punctuation(b as char) {
                    text_fold.push(b as char);
                    norm_spans.push((chunk_start, pos));
                    prev_space = false;
                } else if !b.is_ascii_control() && !prev_space {
                    text_fold.push(' ');
                    norm_spans.push((chunk_start, pos));
                    prev_space = true;
                }
                continue;
            }
        }

        let chunk_start = pos;
        let first_char = text_norm[pos..].chars().next().unwrap();
        let mut chunk_end = chunk_start + first_char.len_utf8();
        let next_b = if chunk_end < len { bytes[chunk_end] } else { 0 };
        let has_trailing_combining = next_b >= 0xCC
            && text_norm[chunk_end..]
                .chars()
                .next()
                .is_some_and(is_combining_mark);

        if !has_trailing_combining {
            if let Some(folded_byte) = fold_vietnamese_nfc_char(first_char) {
                text_fold.push(folded_byte as char);
                norm_spans.push((chunk_start, chunk_end));
                prev_space = false;
                pos = chunk_end;
                continue;
            }
        }

        cluster_buf.clear();
        cluster_buf.push(first_char);

        while chunk_end < len && bytes[chunk_end] >= 0xCC {
            let next_c = text_norm[chunk_end..].chars().next().unwrap();
            if is_combining_mark(next_c) {
                cluster_buf.push(next_c);
                chunk_end += next_c.len_utf8();
            } else {
                break;
            }
        }
        pos = chunk_end;

        // Convert cluster via NFKC first (e.g. '²' -> '2', compatibility forms -> base)
        emitted.clear();
        for kc in cluster_buf.nfkc() {
            if is_zero_width_or_invisible(kc) || kc.is_control() {
                continue;
            }
            if let Some(rep) = fold_special_latin(kc) {
                emitted.push_str(rep);
                continue;
            }
            if let Some(enc) = map_enclosed_decorative_char(kc) {
                for lc in enc.to_lowercase() {
                    emitted.push(lc);
                }
                continue;
            }
            for lc in kc.to_lowercase() {
                if let Some(rep) = fold_special_latin(lc) {
                    emitted.push_str(rep);
                } else {
                    for dc in std::iter::once(lc).nfd() {
                        if is_combining_mark(dc) {
                            continue;
                        }
                        if let Some(rep2) = fold_special_latin(dc) {
                            emitted.push_str(rep2);
                        } else if dc.is_alphanumeric() || is_kept_fold_punctuation(dc) {
                            emitted.push(dc);
                        } else {
                            // Emoji, symbols, decorative glyphs, other punctuation -> space
                            emitted.push(' ');
                        }
                    }
                }
            }
        }

        if emitted.is_empty() {
            continue;
        }

        for ec in emitted.chars() {
            if ec.is_whitespace() {
                if !prev_space {
                    text_fold.push(' ');
                    norm_spans.push((chunk_start, chunk_end));
                    prev_space = true;
                }
            } else {
                let start_len = text_fold.len();
                text_fold.push(ec);
                let added_bytes = text_fold.len() - start_len;
                for _ in 0..added_bytes {
                    norm_spans.push((chunk_start, chunk_end));
                }
                prev_space = false;
            }
        }
    }

    if text_fold.ends_with(' ') {
        text_fold.pop();
        norm_spans.pop();
    }

    FoldedText {
        text_fold,
        norm_spans,
    }
}

/// Detect post language using `whatlang` (`< 20` chars -> `"und"`, `05-pipeline-rules.md §3`).
pub fn detect_lang(text_norm: &str) -> String {
    if text_norm.chars().count() < LANG_DETECT_MIN_CHARS {
        return "und".to_string();
    }
    match whatlang::detect(text_norm) {
        Some(info) => lang_to_code(info.lang()).to_string(),
        None => "und".to_string(),
    }
}

fn lang_to_code(lang: Lang) -> &'static str {
    match lang {
        Lang::Vie => "vi",
        Lang::Eng => "en",
        Lang::Cmn => "zh",
        Lang::Jpn => "ja",
        Lang::Kor => "ko",
        Lang::Fra => "fr",
        Lang::Deu => "de",
        Lang::Spa => "es",
        Lang::Por => "pt",
        Lang::Rus => "ru",
        Lang::Ita => "it",
        Lang::Tha => "th",
        Lang::Khm => "km",
        Lang::Ind => "id",
        Lang::Nld => "nl",
        Lang::Pol => "pl",
        Lang::Tur => "tr",
        Lang::Ara => "ar",
        Lang::Hin => "hi",
        other => other.code(),
    }
}

/// Canonicalize a language tag (`"vie"` -> `"vi"`, `"eng"` -> `"en"`, etc.) for DSL `lang_in`.
pub fn canonical_lang_code(code: &str) -> &str {
    match code.trim() {
        "vie" | "vi" | "vi-VN" | "vi_VN" => "vi",
        "eng" | "en" | "en-US" | "en-GB" => "en",
        "cmn" | "zho" | "zh" => "zh",
        "jpn" | "ja" => "ja",
        "kor" | "ko" => "ko",
        "fra" | "fre" | "fr" => "fr",
        "deu" | "ger" | "de" => "de",
        "spa" | "es" => "es",
        "por" | "pt" => "pt",
        "rus" | "ru" => "ru",
        "tha" | "th" => "th",
        other => other,
    }
}

/// Compute `content_hash`: lowercase hex SHA-256 of `text_fold` after removing all whitespace,
/// punctuation, and ASCII/Unicode digits (`05-pipeline-rules.md §3`).
pub fn compute_content_hash(text_fold: &str) -> String {
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 4];
    for c in text_fold.chars() {
        if c.is_whitespace() || c.is_numeric() || c.is_ascii_punctuation() || !c.is_alphabetic() {
            continue;
        }
        hasher.update(c.encode_utf8(&mut buf).as_bytes());
    }
    let digest = hasher.finalize();
    hex_encode(&digest)
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0F) as usize] as char);
    }
    out
}

///Deterministic 64-bit hash (FNV-1a + SplitMix64 avalanche finalizer) for SimHash shingles.
#[inline]
fn hash_shingle_64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h = (h ^ (h >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    h = (h ^ (h >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    h ^ (h >> 31)
}

/// Compute 64-bit Charikar SimHash over 3-word shingles of `text_fold`,
/// falling back to 1-word tokens when `text_fold` has fewer than 3 words (`05-pipeline-rules.md §3`).
pub fn compute_simhash(text_fold: &str) -> u64 {
    let words: Vec<&str> = text_fold
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();

    if words.is_empty() {
        return 0;
    }

    let mut weights = [0i32; 64];
    if words.len() < 3 {
        for w in &words {
            accumulate_simhash_bits(&mut weights, hash_shingle_64(w.as_bytes()));
        }
    } else {
        let mut shingle_buf = String::with_capacity(48);
        for win in words.windows(3) {
            shingle_buf.clear();
            shingle_buf.push_str(win[0]);
            shingle_buf.push(' ');
            shingle_buf.push_str(win[1]);
            shingle_buf.push(' ');
            shingle_buf.push_str(win[2]);
            accumulate_simhash_bits(&mut weights, hash_shingle_64(shingle_buf.as_bytes()));
        }
    }

    let mut simhash = 0u64;
    for (bit, &weight) in weights.iter().enumerate() {
        if weight > 0 {
            simhash |= 1u64 << bit;
        }
    }
    simhash
}

#[inline]
fn accumulate_simhash_bits(weights: &mut [i32; 64], hash: u64) {
    for (bit, weight) in weights.iter_mut().enumerate() {
        if ((hash >> bit) & 1) == 1 {
            *weight += 1;
        } else {
            *weight -= 1;
        }
    }
}

/// Truncate long `text_norm` for T5 AI input (`05-pipeline-rules.md §7`):
/// posts longer than 2,500 chars keep the first 1,800 chars and last 500 chars.
/// Returns `(possibly_truncated_text, was_truncated)`.
pub fn truncate_for_ai(text_norm: &str) -> (String, bool) {
    const MAX_CHARS: usize = 2_500;
    const HEAD_CHARS: usize = 1_800;
    const TAIL_CHARS: usize = 500;

    let total_chars = text_norm.chars().count();
    if total_chars <= MAX_CHARS {
        return (text_norm.to_string(), false);
    }

    let head_end = text_norm
        .char_indices()
        .nth(HEAD_CHARS)
        .map(|(i, _)| i)
        .unwrap_or(text_norm.len());
    let tail_start = text_norm
        .char_indices()
        .nth(total_chars - TAIL_CHARS)
        .map(|(i, _)| i)
        .unwrap_or(0);

    let mut out = String::with_capacity(head_end + (text_norm.len() - tail_start) + 5);
    out.push_str(&text_norm[..head_end]);
    out.push_str("\n…\n");
    out.push_str(&text_norm[tail_start..]);
    (out, true)
}
