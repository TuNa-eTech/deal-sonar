use std::collections::BTreeMap;

use serde_json::json;

use crate::engine::{
    ClassifyRule, Condition, ExtractRule, PrefilterSpec, RuleVerdict, RulesetBody, Thresholds,
    SUPPORTED_DSL_VERSION,
};
use crate::extractors::{ExtractorConfig, RegexCast, DEFAULT_MONEY_WINDOW};

/// Built-in seed ruleset ID for Vietnamese real estate (`02-radar-spec.md §7`).
pub const SEED_BDS_VI_V1: &str = "bds-vi-v1";

/// Return a built-in seed [`RulesetBody`] by ID (`02-radar-spec.md §7`, `05-pipeline-rules.md §6.3`).
///
/// Currently provides `"bds-vi-v1"` for Vietnamese real estate templates.
pub fn seed_ruleset(id: &str) -> Option<RulesetBody> {
    match id.trim() {
        SEED_BDS_VI_V1 => Some(build_bds_vi_v1()),
        _ => None,
    }
}

fn build_bds_vi_v1() -> RulesetBody {
    let mut deal_type_map = BTreeMap::new();
    deal_type_map.insert(
        "rent".to_string(),
        vec![
            "can thue".to_string(),
            "tim thue".to_string(),
            "muon thue".to_string(),
            "cho thue".to_string(),
            "tim phong".to_string(),
            "thue".to_string(),
        ],
    );
    deal_type_map.insert(
        "buy".to_string(),
        vec![
            "can mua".to_string(),
            "tim mua".to_string(),
            "can ban".to_string(),
            "chinh chu ban".to_string(),
            "mua".to_string(),
            "ban".to_string(),
            "sang nhuong".to_string(),
        ],
    );

    let mut property_type_map = BTreeMap::new();
    property_type_map.insert(
        "apartment".to_string(),
        vec![
            "chung cu mini".to_string(),
            "ccmn".to_string(),
            "can ho".to_string(),
            "chung cu".to_string(),
            "studio".to_string(),
            "duplex".to_string(),
            "penthouse".to_string(),
        ],
    );
    property_type_map.insert(
        "house".to_string(),
        vec![
            "nha nguyen can".to_string(),
            "nha rieng".to_string(),
            "nha mat pho".to_string(),
            "nha pho".to_string(),
            "biet thu".to_string(),
            "lien ke".to_string(),
        ],
    );
    property_type_map.insert(
        "room".to_string(),
        vec![
            "phong tro".to_string(),
            "phong khep kin".to_string(),
            "nha tro".to_string(),
        ],
    );
    property_type_map.insert(
        "land".to_string(),
        vec![
            "dat nen".to_string(),
            "dat tho cu".to_string(),
            "manh dat".to_string(),
            "lo dat".to_string(),
        ],
    );
    property_type_map.insert(
        "commercial".to_string(),
        vec![
            "mat bang".to_string(),
            "van phong".to_string(),
            "kho xuong".to_string(),
            "cua hang".to_string(),
            "shophouse".to_string(),
        ],
    );

    let mut peer_set = BTreeMap::new();
    peer_set.insert("author_role".to_string(), json!("peer"));

    let mut demand_set = BTreeMap::new();
    demand_set.insert("intent".to_string(), json!("demand"));
    demand_set.insert("author_role".to_string(), json!("end_user"));

    RulesetBody {
        dsl: SUPPORTED_DSL_VERSION,
        prefilter: Some(PrefilterSpec {
            any: vec![
                "thue".to_string(),
                "mua".to_string(),
                "ban".to_string(),
                "can ho".to_string(),
                "chung cu".to_string(),
                "phong".to_string(),
                "nha".to_string(),
                "mat bang".to_string(),
                "dat".to_string(),
                "biet thu".to_string(),
                "so do".to_string(),
                "chinh chu".to_string(),
                r"re:\b\d+\s*(?:pn|m2)\b".to_string(),
            ],
            none: vec![
                "tuyen dung nhan vien".to_string(),
                "tuyen sale bds".to_string(),
                "tuyen cong tac vien".to_string(),
                "vay von ngan hang".to_string(),
                "rut tien the tin dung".to_string(),
            ],
            min_len: Some(15),
        }),
        classify: vec![
            ClassifyRule {
                id: "reject_broker_inventory".to_string(),
                when: Condition::KwAny(vec![
                    "ben em co quy can".to_string(),
                    "quy can gia tot".to_string(),
                    "nhan ky gui".to_string(),
                    "hoa hong cho moi gioi".to_string(),
                    "ket hop anh em moi gioi".to_string(),
                ]),
                verdict: RuleVerdict::NoMatch,
                confidence: 0.93,
                set: peer_set,
            },
            ClassifyRule {
                id: "accept_clear_tenant_demand".to_string(),
                when: Condition::All(vec![
                    Condition::KwAny(vec![
                        "can thue".to_string(),
                        "tim thue".to_string(),
                        "muon thue".to_string(),
                        "can tim phong".to_string(),
                        "can tim can ho".to_string(),
                    ]),
                    Condition::KwNone(vec![
                        "cho thue".to_string(),
                        "chinh chu cho thue".to_string(),
                        "ben em co".to_string(),
                        "quy can".to_string(),
                        "hoa hong".to_string(),
                        "ky gui".to_string(),
                        "ib em gui anh".to_string(),
                    ]),
                    Condition::HasField("location".to_string()),
                ]),
                verdict: RuleVerdict::Match,
                confidence: 0.92,
                set: demand_set,
            },
        ],
        extract: vec![
            ExtractRule {
                field: "deal_type".to_string(),
                config: ExtractorConfig::EnumKw {
                    map: deal_type_map,
                    multi: false,
                },
            },
            ExtractRule {
                field: "property_type".to_string(),
                config: ExtractorConfig::EnumKw {
                    map: property_type_map,
                    multi: false,
                },
            },
            ExtractRule {
                field: "location".to_string(),
                config: ExtractorConfig::Gazetteer {
                    dict: "vn_admin".to_string(),
                    scope: None,
                },
            },
            ExtractRule {
                field: "price".to_string(),
                config: ExtractorConfig::VnMoney {
                    near: vec![
                        "gia".to_string(),
                        "tam".to_string(),
                        "khoang".to_string(),
                        "duoi".to_string(),
                        "tai chinh".to_string(),
                        "ngan sach".to_string(),
                        "tc".to_string(),
                        "thue".to_string(),
                        "mua".to_string(),
                        "ban".to_string(),
                    ],
                    window: DEFAULT_MONEY_WINDOW + 10,
                },
            },
            ExtractRule {
                field: "area".to_string(),
                config: ExtractorConfig::VnArea,
            },
            ExtractRule {
                field: "bedrooms".to_string(),
                config: ExtractorConfig::Regex {
                    pattern: r"(\d+)\s*(?:pn|phong ngu|p\.ngu)\b".to_string(),
                    group: 1,
                    cast: RegexCast::Int,
                },
            },
            ExtractRule {
                field: "phone".to_string(),
                config: ExtractorConfig::VnPhone,
            },
        ],
        thresholds: Thresholds {
            accept: 0.9,
            reject: 0.9,
        },
    }
}
