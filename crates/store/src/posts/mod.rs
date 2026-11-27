use std::collections::BTreeSet;

use rusqlite::{params, params_from_iter, types::Value as SqlValue, OptionalExtension, Row};

use crate::models::{
    build_fts5_query, extract_e164_phones_light, hamming_distance, new_ulid, simhash_bands,
    AlsoSeenInEntry, AttachDupResult, AuthorInput, AuthorRecord, DupClusterRecord, NewPost,
    PeerSignals, PostDetail, PostRecord, RejectedEvaluationItem, SimhashMatch,
};
use crate::{Store, StoreError};

mod dedup;
mod ingest;
mod peers;
mod queries;
mod rows;

pub(crate) use rows::*;
