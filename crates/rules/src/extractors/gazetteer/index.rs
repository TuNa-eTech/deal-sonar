//! Gazetteer index types and the fast static word map.

use super::*;

#[derive(Debug, Clone, Copy)]
pub(super) struct AdminEntry {
    pub(super) province: &'static str,
    pub(super) district: Option<&'static str>,
    pub(super) ward: Option<&'static str>,
    /// Unambiguous folded aliases/names
    pub(super) aliases: &'static [&'static str],
    /// Short abbreviations (e.g. `cg`, `tx`, `dd`, `hm`, `lb`, `dn`)
    pub(super) short_aliases: &'static [&'static str],
}

#[derive(Debug, Clone, Copy)]
pub(super) struct CompiledAlias {
    pub(super) entry_idx: usize,
    pub(super) is_short: bool,
    /// `0` if `phrase.len() <= first_word.len() + 1`, else `phrase.as_bytes()[first_word.len() + 1]`
    pub(super) next_byte: u8,
    /// `0` if `phrase.len() <= first_word.len() + 2`, else `phrase.as_bytes()[first_word.len() + 2]`
    pub(super) next_byte2: u8,
}

pub(super) struct FirstWordBucket {
    pub(super) has_short_phrase: bool,
    pub(super) next_byte_mask: u128,
    pub(super) items: Vec<(&'static str, CompiledAlias)>,
}

pub(super) struct FastStaticWordMap<V> {
    pub(super) mask: usize,
    pub(super) slots: Vec<Option<(&'static str, V)>>,
}

impl<V> FastStaticWordMap<V> {
    pub(super) fn with_capacity(entries_len: usize) -> Self {
        let cap = (entries_len.saturating_mul(8)).next_power_of_two().max(64);
        let mut slots = Vec::with_capacity(cap);
        slots.resize_with(cap, || None);
        Self {
            mask: cap - 1,
            slots,
        }
    }

    #[inline(always)]
    pub(super) fn hash_word(bytes: &[u8]) -> usize {
        let mut h = 0xcbf2_9ce4_8422_2325_u64;
        let mut i = 0usize;
        while i < bytes.len() {
            h = (h ^ (bytes[i] as u64)).wrapping_mul(0x0100_0000_01b3);
            i += 1;
        }
        (h ^ (h >> 32)) as usize
    }

    pub(super) fn insert(&mut self, key: &'static str, val: V) {
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
    pub(super) fn get(&self, key: &str) -> Option<&V> {
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

pub(super) struct GazetteerIndex {
    pub(super) entries: Vec<AdminEntry>,
    /// Fast `(first_byte, word_len)` bitmask prefilter before table lookup.
    pub(super) first_word_mask: [u64; 256],
    /// Fast `(first_byte, second_byte)` bitmask prefilter (`b0 < 128`, `b1 < 128`).
    pub(super) first_two_mask: [u128; 128],
    /// Open-addressed FNV-1a table from first token -> `FirstWordBucket` (avoids SipHash per word).
    pub(super) by_first_word: FastStaticWordMap<FirstWordBucket>,
    /// Map from folded province alias -> canonical province name (for `scope` resolution)
    pub(super) province_scope_map: HashMap<&'static str, &'static str>,
}
