//! Source commands (`source_*`).

use super::*;

impl CoreService {
    // ========================================================================
    // 3. Sources (`source_*`)
    // ========================================================================

    pub fn source_list(&self) -> CoreResult<Vec<Source>> {
        let now = now_ms();
        let items = self.rt.store.source_list(now)?;
        let last_errors = self.rt.get_source_last_errors()?;

        Ok(items
            .into_iter()
            .map(|item| {
                let s = item.source;
                let last_error = last_errors.get(&s.id).cloned();
                Source {
                    id: s.id,
                    platform: s.platform,
                    kind: s.kind,
                    external_id: s.external_id,
                    name: s.name,
                    url: s.url,
                    privacy: s.privacy,
                    member_count: s.member_count,
                    profile_id: s.profile_id,
                    followed: s.followed,
                    priority: s.priority > 0,
                    state: SourceState::from_db(&s.state),
                    last_crawl_at: s.last_crawl_at,
                    avg_new_posts: s.avg_new_posts,
                    posts_per_day: item.posts_last_24h,
                    stored_post_count: item.stored_post_count,
                    last_error,
                    created_at: s.created_at,
                }
            })
            .collect())
    }

    pub fn source_follow(&self, id: &str) -> CoreResult<Source> {
        self.ensure_not_shutting_down()?;
        let now = now_ms();
        let existing = self
            .rt
            .store
            .source_get(id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "source",
                id: id.to_string(),
            })?;

        if !existing.followed {
            let license = self.rt.current_license_status(now)?;
            let cur_followed =
                usize::try_from(self.rt.store.count_followed_sources()?.max(0)).unwrap_or(0);
            if cur_followed >= license.limits.max_followed_groups {
                return Err(CoreError::LicenseLimitExceeded(format!(
                    "Current {:?} plan allows following at most {} groups",
                    license.plan, license.limits.max_followed_groups
                )));
            }
            self.rt.store.source_follow(id)?;
            let _ = self.rt.bump_and_push_config()?;
        }

        self.get_source_dto(id)
    }

    pub fn source_unfollow(&self, id: &str) -> CoreResult<Source> {
        self.ensure_not_shutting_down()?;
        let _ = self
            .rt
            .store
            .source_get(id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "source",
                id: id.to_string(),
            })?;
        self.rt.store.source_unfollow(id)?;
        let _ = self.rt.bump_and_push_config()?;
        self.get_source_dto(id)
    }

    pub fn source_set_priority(&self, id: &str, priority: bool) -> CoreResult<Source> {
        self.ensure_not_shutting_down()?;
        let existing = self
            .rt
            .store
            .source_get(id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "source",
                id: id.to_string(),
            })?;

        if priority && existing.priority <= 0 {
            let all_sources = self.rt.store.source_list(now_ms())?;
            let cur_priority_count = all_sources
                .iter()
                .filter(|s| s.source.priority > 0 && s.source.id != id)
                .count();
            if cur_priority_count >= crate::scheduler::MAX_PRIORITY_SOURCES {
                return Err(CoreError::Validation(format!(
                    "Maximum {} priority groups allowed (`02-extension.md §6.2`)",
                    crate::scheduler::MAX_PRIORITY_SOURCES
                )));
            }
        }

        self.rt
            .store
            .source_set_priority(id, if priority { 1 } else { 0 })?;
        let _ = self.rt.bump_and_push_config()?;
        self.get_source_dto(id)
    }

    pub fn source_crawl_now(
        &self,
        id: &str,
        reason: Option<&str>,
    ) -> CoreResult<SourceCrawlNowResult> {
        self.ensure_not_shutting_down()?;
        let source = self
            .rt
            .store
            .source_get(id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "source",
                id: id.to_string(),
            })?;
        let crawl_reason = match reason {
            Some("preview") => CrawlReason::Preview,
            _ => CrawlReason::Manual,
        };
        let settings = self.rt.load_settings()?;
        let sent = push_crawl_request(
            &self.rt,
            &source,
            crawl_reason,
            settings.crawl_policy.max_posts_per_visit,
        );
        Ok(SourceCrawlNowResult {
            queued: sent > 0,
            run_id: dealsonar_protocol::new_ulid(),
        })
    }

    pub(super) fn get_source_dto(&self, id: &str) -> CoreResult<Source> {
        self.source_list()?
            .into_iter()
            .find(|s| s.id == id)
            .ok_or_else(|| CoreError::NotFound {
                entity: "source",
                id: id.to_string(),
            })
    }
}
