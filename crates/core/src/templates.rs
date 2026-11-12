//! Built-in Radar industry templates loader (`02-radar-spec.md §7`, `apps/desktop/templates/*.json`).
//!
//! Embeds all 7 official Vietnamese templates via `include_str!` so `template_list` and
//! `template_get` always succeed regardless of the process working directory, while also
//! supporting an optional disk directory override (`templates_dir`).

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use crate::dto::RadarTemplate;
use crate::error::{CoreError, CoreResult};

const EMBEDDED_TEMPLATES: &[(&str, &str)] = &[
    (
        "bds.khach-thue",
        include_str!("../../../apps/desktop/templates/bds.khach-thue.json"),
    ),
    (
        "bds.chinh-chu",
        include_str!("../../../apps/desktop/templates/bds.chinh-chu.json"),
    ),
    (
        "tuyen-dung.tim-viec",
        include_str!("../../../apps/desktop/templates/tuyen-dung.tim-viec.json"),
    ),
    (
        "xe-cu.duoi-gia",
        include_str!("../../../apps/desktop/templates/xe-cu.duoi-gia.json"),
    ),
    (
        "van-tai.ghep-hang",
        include_str!("../../../apps/desktop/templates/van-tai.ghep-hang.json"),
    ),
    (
        "dich-vu.tim-tho",
        include_str!("../../../apps/desktop/templates/dich-vu.tim-tho.json"),
    ),
    (
        "order.hoi-mua",
        include_str!("../../../apps/desktop/templates/order.hoi-mua.json"),
    ),
];

/// Load all radar templates, merging any valid `.json` files in `disk_dir` on top of the
/// 7 embedded templates while preserving canonical ordering.
pub fn load_templates(disk_dir: Option<&Path>) -> CoreResult<Vec<RadarTemplate>> {
    let mut ordered_ids = Vec::with_capacity(EMBEDDED_TEMPLATES.len());
    let mut by_id: BTreeMap<String, RadarTemplate> = BTreeMap::new();

    for (_expected_id, raw_json) in EMBEDDED_TEMPLATES {
        let tpl: RadarTemplate = serde_json::from_str(raw_json)?;
        ordered_ids.push(tpl.id.clone());
        by_id.insert(tpl.id.clone(), tpl);
    }

    if let Some(dir) = disk_dir {
        if dir.is_dir() {
            let mut entries: Vec<_> = fs::read_dir(dir)?
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("json"))
                .collect();
            entries.sort();
            for path in entries {
                if let Ok(raw) = fs::read_to_string(&path) {
                    if let Ok(tpl) = serde_json::from_str::<RadarTemplate>(&raw) {
                        if !by_id.contains_key(&tpl.id) {
                            ordered_ids.push(tpl.id.clone());
                        }
                        by_id.insert(tpl.id.clone(), tpl);
                    }
                }
            }
        }
    }

    let mut out = Vec::with_capacity(ordered_ids.len());
    for id in ordered_ids {
        if let Some(tpl) = by_id.remove(&id) {
            out.push(tpl);
        }
    }
    Ok(out)
}

/// Fetch a single radar template by ID (`e.g. "bds.khach-thue"`).
pub fn get_template(id: &str, disk_dir: Option<&Path>) -> CoreResult<RadarTemplate> {
    let trimmed = id.trim();
    load_templates(disk_dir)?
        .into_iter()
        .find(|t| t.id == trimmed)
        .ok_or_else(|| CoreError::NotFound {
            entity: "template",
            id: trimmed.to_string(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_all_seven_embedded_templates() {
        let list = load_templates(None).expect("embedded templates parse cleanly");
        assert_eq!(list.len(), 7);

        let bds_thue = get_template("bds.khach-thue", None).expect("bds.khach-thue exists");
        assert_eq!(bds_thue.seed_ruleset.as_deref(), Some("bds-vi-v1"));
        assert!(!bds_thue.fields.is_empty());

        let bds_cc = get_template("bds.chinh-chu", None).expect("bds.chinh-chu exists");
        assert!(!bds_cc.fields.is_empty());
    }
}
