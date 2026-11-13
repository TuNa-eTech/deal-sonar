use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{
    params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension, Row,
};

use crate::models::{
    build_fts5_query, is_valid_field_key, new_ulid, AlsoSeenInEntry, CreateLeadInput,
    EvaluationDoneInput, EvaluationRecord, EvaluationUpsertInput, ExtractedField, FeedbackRecord,
    FieldDef, FieldSource, FieldType, FilterOp, LabeledSample, LabeledSampleOrigin, LeadDetail,
    LeadEvaluationInfo, LeadEventRecord, LeadFieldFilter, LeadListItem, LeadListPage,
    LeadListQuery, LeadRecord, PendingAiEvaluationItem, PendingAiGroup, RecordFeedbackInput,
    SortDir,
};
use crate::posts::map_post_row;
use crate::{Store, StoreError};

mod dynamic_filter;
mod evaluations;
mod feedback;
mod list;
mod records;
mod rows;

use dynamic_filter::*;
use list::*;
pub(crate) use rows::*;
