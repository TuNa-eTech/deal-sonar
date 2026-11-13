//! Cross-crate converters for field types, field definitions, policies, notify config, and extracted fields.

use super::*;

// ============================================================================
// Cross-Crate Type Converters (`store` <-> `rules` <-> `ai-bridge` <-> `notify` <-> `dto`)
// ============================================================================

pub fn field_type_to_store(ft: FieldType) -> dealsonar_store::models::FieldType {
    match ft {
        FieldType::Text => dealsonar_store::models::FieldType::Text,
        FieldType::Number => dealsonar_store::models::FieldType::Number,
        FieldType::Money => dealsonar_store::models::FieldType::Money,
        FieldType::Phone => dealsonar_store::models::FieldType::Phone,
        FieldType::Location => dealsonar_store::models::FieldType::Location,
        FieldType::Enum => dealsonar_store::models::FieldType::Enum,
        FieldType::MultiEnum => dealsonar_store::models::FieldType::MultiEnum,
        FieldType::Boolean => dealsonar_store::models::FieldType::Boolean,
        FieldType::Date => dealsonar_store::models::FieldType::Date,
        FieldType::Range => dealsonar_store::models::FieldType::Range,
        FieldType::Url => dealsonar_store::models::FieldType::Url,
    }
}

pub fn field_type_from_store(ft: dealsonar_store::models::FieldType) -> FieldType {
    match ft {
        dealsonar_store::models::FieldType::Text => FieldType::Text,
        dealsonar_store::models::FieldType::Number => FieldType::Number,
        dealsonar_store::models::FieldType::Money => FieldType::Money,
        dealsonar_store::models::FieldType::Phone => FieldType::Phone,
        dealsonar_store::models::FieldType::Location => FieldType::Location,
        dealsonar_store::models::FieldType::Enum => FieldType::Enum,
        dealsonar_store::models::FieldType::MultiEnum => FieldType::MultiEnum,
        dealsonar_store::models::FieldType::Boolean => FieldType::Boolean,
        dealsonar_store::models::FieldType::Date => FieldType::Date,
        dealsonar_store::models::FieldType::Range => FieldType::Range,
        dealsonar_store::models::FieldType::Url => FieldType::Url,
    }
}

pub fn field_type_to_rules(ft: FieldType) -> dealsonar_rules::FieldType {
    match ft {
        FieldType::Text => dealsonar_rules::FieldType::Text,
        FieldType::Number => dealsonar_rules::FieldType::Number,
        FieldType::Money => dealsonar_rules::FieldType::Money,
        FieldType::Phone => dealsonar_rules::FieldType::Phone,
        FieldType::Location => dealsonar_rules::FieldType::Location,
        FieldType::Enum => dealsonar_rules::FieldType::Enum,
        FieldType::MultiEnum => dealsonar_rules::FieldType::MultiEnum,
        FieldType::Boolean => dealsonar_rules::FieldType::Boolean,
        FieldType::Date => dealsonar_rules::FieldType::Date,
        FieldType::Range => dealsonar_rules::FieldType::Range,
        FieldType::Url => dealsonar_rules::FieldType::Url,
    }
}

pub fn field_type_to_ai(ft: FieldType) -> dealsonar_ai_bridge::FieldType {
    match ft {
        FieldType::Text => dealsonar_ai_bridge::FieldType::Text,
        FieldType::Number => dealsonar_ai_bridge::FieldType::Number,
        FieldType::Money => dealsonar_ai_bridge::FieldType::Money,
        FieldType::Phone => dealsonar_ai_bridge::FieldType::Phone,
        FieldType::Location => dealsonar_ai_bridge::FieldType::Location,
        FieldType::Enum => dealsonar_ai_bridge::FieldType::Enum,
        FieldType::MultiEnum => dealsonar_ai_bridge::FieldType::MultiEnum,
        FieldType::Boolean => dealsonar_ai_bridge::FieldType::Boolean,
        FieldType::Date => dealsonar_ai_bridge::FieldType::Date,
        FieldType::Range => dealsonar_ai_bridge::FieldType::Range,
        FieldType::Url => dealsonar_ai_bridge::FieldType::Url,
    }
}

pub fn field_type_from_ai(ft: dealsonar_ai_bridge::FieldType) -> FieldType {
    match ft {
        dealsonar_ai_bridge::FieldType::Text => FieldType::Text,
        dealsonar_ai_bridge::FieldType::Number => FieldType::Number,
        dealsonar_ai_bridge::FieldType::Money => FieldType::Money,
        dealsonar_ai_bridge::FieldType::Phone => FieldType::Phone,
        dealsonar_ai_bridge::FieldType::Location => FieldType::Location,
        dealsonar_ai_bridge::FieldType::Enum => FieldType::Enum,
        dealsonar_ai_bridge::FieldType::MultiEnum => FieldType::MultiEnum,
        dealsonar_ai_bridge::FieldType::Boolean => FieldType::Boolean,
        dealsonar_ai_bridge::FieldType::Date => FieldType::Date,
        dealsonar_ai_bridge::FieldType::Range => FieldType::Range,
        dealsonar_ai_bridge::FieldType::Url => FieldType::Url,
    }
}

pub fn field_type_to_notify(ft: FieldType) -> dealsonar_notify::FieldType {
    match ft {
        FieldType::Text => dealsonar_notify::FieldType::Text,
        FieldType::Number => dealsonar_notify::FieldType::Number,
        FieldType::Money => dealsonar_notify::FieldType::Money,
        FieldType::Phone => dealsonar_notify::FieldType::Phone,
        FieldType::Location => dealsonar_notify::FieldType::Location,
        FieldType::Enum => dealsonar_notify::FieldType::Enum,
        FieldType::MultiEnum => dealsonar_notify::FieldType::MultiEnum,
        FieldType::Boolean => dealsonar_notify::FieldType::Boolean,
        FieldType::Date => dealsonar_notify::FieldType::Date,
        FieldType::Range => dealsonar_notify::FieldType::Range,
        FieldType::Url => dealsonar_notify::FieldType::Url,
    }
}

pub fn field_def_from_ai(sf: &dealsonar_ai_bridge::SuggestedField, order: i32) -> FieldDef {
    FieldDef {
        key: sf.key.clone(),
        label: sf.label.clone(),
        r#type: field_type_from_ai(sf.r#type),
        description: sf.description.clone(),
        required: sf.required,
        options: sf.options.clone(),
        show_in_alert: true,
        order,
    }
}

pub fn field_def_to_store(f: &FieldDef) -> dealsonar_store::models::FieldDef {
    dealsonar_store::models::FieldDef {
        key: f.key.clone(),
        label: f.label.clone(),
        r#type: field_type_to_store(f.r#type),
        description: f.description.clone(),
        required: f.required,
        options: f.options.clone(),
        show_in_alert: f.show_in_alert,
        order: f.order,
    }
}

pub fn field_def_from_store(f: &dealsonar_store::models::FieldDef) -> FieldDef {
    FieldDef {
        key: f.key.clone(),
        label: f.label.clone(),
        r#type: field_type_from_store(f.r#type),
        description: f.description.clone(),
        required: f.required,
        options: f.options.clone(),
        show_in_alert: f.show_in_alert,
        order: f.order,
    }
}

pub fn field_def_store_to_rules(
    f: &dealsonar_store::models::FieldDef,
) -> dealsonar_rules::FieldDef {
    let dto = field_def_from_store(f);
    dealsonar_rules::FieldDef {
        key: dto.key,
        label: dto.label,
        r#type: field_type_to_rules(dto.r#type),
        description: dto.description,
        required: dto.required,
        options: dto.options,
        show_in_alert: dto.show_in_alert,
        order: dto.order,
    }
}

pub fn field_def_store_to_ai(
    f: &dealsonar_store::models::FieldDef,
) -> dealsonar_ai_bridge::FieldDef {
    let dto = field_def_from_store(f);
    dealsonar_ai_bridge::FieldDef {
        key: dto.key,
        label: dto.label,
        r#type: field_type_to_ai(dto.r#type),
        description: dto.description,
        required: dto.required,
        options: dto.options,
        show_in_alert: dto.show_in_alert,
        order: dto.order,
    }
}

pub fn field_def_store_to_notify(
    f: &dealsonar_store::models::FieldDef,
) -> dealsonar_notify::FieldDef {
    let dto = field_def_from_store(f);
    dealsonar_notify::FieldDef {
        key: dto.key,
        label: dto.label,
        r#type: field_type_to_notify(dto.r#type),
        description: dto.description,
        required: dto.required,
        options: dto.options,
        show_in_alert: dto.show_in_alert,
        order: dto.order,
    }
}

pub fn filter_op_to_store(op: FilterOperator) -> dealsonar_store::models::FilterOp {
    match op {
        FilterOperator::Eq => dealsonar_store::models::FilterOp::Eq,
        FilterOperator::Ne => dealsonar_store::models::FilterOp::Ne,
        FilterOperator::In => dealsonar_store::models::FilterOp::In,
        FilterOperator::Lt => dealsonar_store::models::FilterOp::Lt,
        FilterOperator::Lte => dealsonar_store::models::FilterOp::Lte,
        FilterOperator::Gt => dealsonar_store::models::FilterOp::Gt,
        FilterOperator::Gte => dealsonar_store::models::FilterOp::Gte,
        FilterOperator::Between => dealsonar_store::models::FilterOp::Between,
        FilterOperator::Contains => dealsonar_store::models::FilterOp::Contains,
        FilterOperator::IsEmpty => dealsonar_store::models::FilterOp::IsEmpty,
    }
}

pub fn filter_op_from_store(op: dealsonar_store::models::FilterOp) -> FilterOperator {
    match op {
        dealsonar_store::models::FilterOp::Eq => FilterOperator::Eq,
        dealsonar_store::models::FilterOp::Ne => FilterOperator::Ne,
        dealsonar_store::models::FilterOp::In => FilterOperator::In,
        dealsonar_store::models::FilterOp::Lt => FilterOperator::Lt,
        dealsonar_store::models::FilterOp::Lte => FilterOperator::Lte,
        dealsonar_store::models::FilterOp::Gt => FilterOperator::Gt,
        dealsonar_store::models::FilterOp::Gte => FilterOperator::Gte,
        dealsonar_store::models::FilterOp::Between => FilterOperator::Between,
        dealsonar_store::models::FilterOp::Contains => FilterOperator::Contains,
        dealsonar_store::models::FilterOp::IsEmpty => FilterOperator::IsEmpty,
    }
}

pub fn filter_op_store_to_rules(
    op: dealsonar_store::models::FilterOp,
) -> dealsonar_rules::FilterOp {
    match op {
        dealsonar_store::models::FilterOp::Eq => dealsonar_rules::FilterOp::Eq,
        dealsonar_store::models::FilterOp::Ne => dealsonar_rules::FilterOp::Ne,
        dealsonar_store::models::FilterOp::In => dealsonar_rules::FilterOp::In,
        dealsonar_store::models::FilterOp::Lt => dealsonar_rules::FilterOp::Lt,
        dealsonar_store::models::FilterOp::Lte => dealsonar_rules::FilterOp::Lte,
        dealsonar_store::models::FilterOp::Gt => dealsonar_rules::FilterOp::Gt,
        dealsonar_store::models::FilterOp::Gte => dealsonar_rules::FilterOp::Gte,
        dealsonar_store::models::FilterOp::Between => dealsonar_rules::FilterOp::Between,
        dealsonar_store::models::FilterOp::Contains => dealsonar_rules::FilterOp::Contains,
        dealsonar_store::models::FilterOp::IsEmpty => dealsonar_rules::FilterOp::IsEmpty,
    }
}

pub fn match_policy_to_store(mp: &MatchPolicy) -> dealsonar_store::models::MatchPolicy {
    dealsonar_store::models::MatchPolicy {
        want_intent: mp.want_intent.as_str().to_string(),
        exclude_roles: mp
            .exclude_roles
            .iter()
            .map(|r| r.as_str().to_string())
            .collect(),
        hard_filters: mp
            .hard_filters
            .iter()
            .map(|hf| dealsonar_store::models::HardFilter {
                field: hf.field.clone(),
                op: filter_op_to_store(hf.op),
                value: hf.value.clone(),
                when_missing: hf.when_missing.as_str().to_string(),
            })
            .collect(),
        extra: BTreeMap::new(),
    }
}

pub fn match_policy_from_store(mp: &dealsonar_store::models::MatchPolicy) -> MatchPolicy {
    MatchPolicy {
        want_intent: WantIntent::from_db(&mp.want_intent),
        exclude_roles: mp
            .exclude_roles
            .iter()
            .map(|r| AuthorRole::from_db(Some(r.as_str())))
            .collect(),
        hard_filters: mp
            .hard_filters
            .iter()
            .map(|hf| HardFilter {
                field: hf.field.clone(),
                op: filter_op_from_store(hf.op),
                value: hf.value.clone(),
                when_missing: WhenMissing::from_db(&hf.when_missing),
            })
            .collect(),
    }
}

pub fn hard_filters_store_to_rules(
    filters: &[dealsonar_store::models::HardFilter],
) -> Vec<dealsonar_rules::HardFilter> {
    filters
        .iter()
        .map(|hf| dealsonar_rules::HardFilter {
            field: hf.field.clone(),
            op: filter_op_store_to_rules(hf.op),
            value: hf.value.clone(),
            when_missing: if hf.when_missing == "fail" {
                dealsonar_rules::WhenMissing::Fail
            } else {
                dealsonar_rules::WhenMissing::Pass
            },
        })
        .collect()
}

pub fn notify_to_store(n: &RadarNotifyConfig) -> dealsonar_store::models::NotifyConfig {
    dealsonar_store::models::NotifyConfig {
        channel_ids: n.channel_ids.clone(),
        mode: n.mode.as_str().to_string(),
        min_score: n.min_score,
        quiet_hours: n
            .quiet_hours
            .as_ref()
            .map(|q| dealsonar_store::models::QuietHours {
                from: q.from.clone(),
                to: q.to.clone(),
            }),
    }
}

pub fn notify_from_store(n: &dealsonar_store::models::NotifyConfig) -> RadarNotifyConfig {
    RadarNotifyConfig {
        channel_ids: n.channel_ids.clone(),
        mode: NotifyMode::from_db(&n.mode),
        min_score: n.min_score,
        quiet_hours: n.quiet_hours.as_ref().map(|q| QuietHours {
            from: q.from.clone(),
            to: q.to.clone(),
        }),
    }
}

pub fn radar_version_from_store(rv: &dealsonar_store::models::RadarVersionRecord) -> RadarVersion {
    RadarVersion {
        id: rv.id.clone(),
        radar_id: rv.radar_id.clone(),
        version: rv.version,
        description: rv.description.clone(),
        language_hint: rv.language_hint.clone(),
        user_profession: rv.user_profession.clone(),
        fields: rv.fields.iter().map(field_def_from_store).collect(),
        match_policy: match_policy_from_store(&rv.match_policy),
        created_at: rv.created_at,
    }
}

pub fn extracted_field_from_store(ef: &dealsonar_store::models::ExtractedField) -> ExtractedField {
    ExtractedField {
        value: ef.value.clone(),
        raw: ef.raw.clone(),
        confidence: ef.confidence,
        source: match ef.source {
            dealsonar_store::models::FieldSource::Ai => FieldSource::Ai,
            dealsonar_store::models::FieldSource::Rule => FieldSource::Rule,
            dealsonar_store::models::FieldSource::User => FieldSource::User,
        },
    }
}

pub fn extracted_field_rules_to_store(
    ef: &dealsonar_rules::ExtractedField,
) -> dealsonar_store::models::ExtractedField {
    dealsonar_store::models::ExtractedField {
        value: ef.value.clone(),
        raw: Some(ef.raw.clone()),
        confidence: ef.confidence,
        source: match ef.source {
            dealsonar_rules::FieldSource::Ai => dealsonar_store::models::FieldSource::Ai,
            dealsonar_rules::FieldSource::Rule => dealsonar_store::models::FieldSource::Rule,
            dealsonar_rules::FieldSource::User => dealsonar_store::models::FieldSource::User,
        },
    }
}

pub fn extracted_field_store_to_rules(
    ef: &dealsonar_store::models::ExtractedField,
) -> Option<dealsonar_rules::ExtractedField> {
    let raw = ef.raw.clone().unwrap_or_default();
    if raw.trim().is_empty() {
        return None;
    }
    Some(dealsonar_rules::ExtractedField {
        value: ef.value.clone(),
        raw,
        confidence: ef.confidence,
        source: match ef.source {
            dealsonar_store::models::FieldSource::Ai => dealsonar_rules::FieldSource::Ai,
            dealsonar_store::models::FieldSource::Rule => dealsonar_rules::FieldSource::Rule,
            dealsonar_store::models::FieldSource::User => dealsonar_rules::FieldSource::User,
        },
    })
}

pub fn extracted_field_ai_to_rules(
    ef: &dealsonar_ai_bridge::ExtractedField,
) -> dealsonar_rules::ExtractedField {
    dealsonar_rules::ExtractedField {
        value: ef.value.clone(),
        raw: ef.raw.clone(),
        confidence: ef.confidence,
        source: match ef.source {
            dealsonar_ai_bridge::FieldSource::Ai => dealsonar_rules::FieldSource::Ai,
            dealsonar_ai_bridge::FieldSource::Rule => dealsonar_rules::FieldSource::Rule,
            dealsonar_ai_bridge::FieldSource::User => dealsonar_rules::FieldSource::User,
        },
    }
}

pub fn extracted_fields_store_to_notify(
    fields: &BTreeMap<String, dealsonar_store::models::ExtractedField>,
) -> HashMap<String, dealsonar_notify::ExtractedField> {
    fields
        .iter()
        .map(|(k, v)| {
            (
                k.clone(),
                dealsonar_notify::ExtractedField {
                    value: v.value.clone(),
                    raw: v.raw.clone().unwrap_or_default(),
                    confidence: v.confidence,
                    source: match v.source {
                        dealsonar_store::models::FieldSource::Ai => {
                            dealsonar_notify::FieldSource::Ai
                        }
                        dealsonar_store::models::FieldSource::Rule => {
                            dealsonar_notify::FieldSource::Rule
                        }
                        dealsonar_store::models::FieldSource::User => {
                            dealsonar_notify::FieldSource::User
                        }
                    },
                },
            )
        })
        .collect()
}
