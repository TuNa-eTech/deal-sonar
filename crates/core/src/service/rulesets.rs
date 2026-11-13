//! Ruleset commands (`ruleset_*`).

use super::*;

impl CoreService {
    // ========================================================================
    // 7. Rulesets (`ruleset_*`)
    // ========================================================================

    pub fn ruleset_list(
        &self,
        radar_id: &str,
        radar_version_id: Option<&str>,
    ) -> CoreResult<Vec<Ruleset>> {
        let target_rvid = match radar_version_id {
            Some(rvid) if !rvid.trim().is_empty() => rvid.to_string(),
            _ => {
                let rw = self
                    .rt
                    .store
                    .radar_get(radar_id)?
                    .ok_or_else(|| CoreError::NotFound {
                        entity: "radar",
                        id: radar_id.to_string(),
                    })?;
                rw.current_version.id
            }
        };
        let records = self.rt.store.list_rulesets(&target_rvid)?;
        Ok(records.iter().map(ruleset_record_to_dto).collect())
    }

    pub fn ruleset_save_user(
        &self,
        radar_id: &str,
        radar_version_id: &str,
        body: RulesetBody,
    ) -> CoreResult<Ruleset> {
        self.ensure_not_shutting_down()?;
        let rw = self
            .rt
            .store
            .radar_get(radar_id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "radar",
                id: radar_id.to_string(),
            })?;
        if rw.current_version.id != radar_version_id
            && rw
                .candidate_version
                .as_ref()
                .is_none_or(|c| c.id != radar_version_id)
        {
            return Err(CoreError::Validation(format!(
                "radar_version_id '{}' does not belong to radar '{}'",
                radar_version_id, radar_id
            )));
        }
        save_user_ruleset(&self.rt, radar_version_id, body, now_ms())
    }

    pub async fn ruleset_compile_now(&self, radar_id: &str) -> CoreResult<RulesetCompileResult> {
        self.ensure_not_shutting_down()?;
        let now = monotonic_radar_now_ms();
        let license = self.rt.current_license_status(now)?;
        if !license.limits.allow_auto_rulesets {
            return Err(CoreError::LicenseLimitExceeded(
                "AI auto-ruleset compilation requires the Pro (Chuyên nghiệp) plan; manual ruleset editing is available on all plans".to_string(),
            ));
        }

        let rw = self
            .rt
            .store
            .radar_get(radar_id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "radar",
                id: radar_id.to_string(),
            })?;
        let rvid = rw.current_version.id.clone();

        // Record a durable job and run compilation immediately so UI gets instant feedback when samples exist
        let dedup = format!("compile_ruleset:{rvid}");
        let (job, _) = self.rt.store.enqueue_job(
            "compile_ruleset",
            Some(&dedup),
            &json!({ "radar_version_id": rvid }),
            now,
            now,
        )?;

        if let Some(claimed) = self.rt.store.claim_due_job(now)? {
            if claimed.id == job.id {
                match run_compile_ruleset_for_version(&self.rt, &rvid).await {
                    Ok(opt_rs) => {
                        let _ = self.rt.store.complete_job(&claimed.id);
                        return Ok(RulesetCompileResult {
                            job_id: claimed.id,
                            ruleset: opt_rs.as_ref().map(ruleset_record_to_dto),
                        });
                    }
                    Err(err) => {
                        let _ =
                            self.rt
                                .store
                                .fail_or_retry_job(&claimed.id, &err.to_string(), None);
                        return Err(err);
                    }
                }
            }
        }

        Ok(RulesetCompileResult {
            job_id: job.id,
            ruleset: None,
        })
    }
}
