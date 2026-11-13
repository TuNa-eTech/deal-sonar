//! Post and rejected-evaluation commands.

use super::*;

impl CoreService {
    // ========================================================================
    // 5. Posts & Rejected Evaluations (`post_*`, `evaluation_list_rejected`)
    // ========================================================================

    pub fn post_get(&self, id: &str) -> CoreResult<Post> {
        let detail = self
            .rt
            .store
            .post_get(id)?
            .ok_or_else(|| CoreError::NotFound {
                entity: "post",
                id: id.to_string(),
            })?;
        Ok(post_detail_to_dto(&detail))
    }

    pub fn post_search(
        &self,
        query: &str,
        source_id: Option<&str>,
        limit: usize,
    ) -> CoreResult<Vec<Post>> {
        let items = self.rt.store.post_search(query, source_id, limit)?;
        Ok(items.iter().map(post_detail_to_dto).collect())
    }

    pub fn evaluation_list_rejected(
        &self,
        radar_id: &str,
        limit: usize,
    ) -> CoreResult<Vec<RejectedEvaluation>> {
        let items = self.rt.store.evaluation_list_rejected(radar_id, limit)?;
        let fb_map = self.rt.get_eval_feedback_labels()?;

        Ok(items
            .into_iter()
            .map(|it| {
                let marked_missed = fb_map
                    .get(&it.evaluation_id)
                    .is_some_and(|l| l == "missed")
                    .then_some(true);
                RejectedEvaluation {
                    evaluation_id: it.evaluation_id,
                    post_id: it.post_id,
                    radar_id: radar_id.to_string(),
                    radar_version_id: it.radar_version_id,
                    decided_by: DecidedBy::from_db(it.decided_by.as_deref()),
                    reject_reason: RejectReason::from_db(it.reject_reason.as_deref()),
                    score: it.score,
                    reason: it.reason,
                    source_name: it.source_name,
                    author_name: it.author_name.unwrap_or_else(|| "Ẩn danh".to_string()),
                    permalink: it.permalink,
                    post_text: it.post_text.unwrap_or_default(),
                    captured_at: it.created_at,
                    marked_missed,
                }
            })
            .collect())
    }
}

pub(super) fn post_detail_to_dto(detail: &dealsonar_store::models::PostDetail) -> Post {
    Post {
        id: detail.post.id.clone(),
        platform: detail.post.platform.clone(),
        external_id: detail.post.external_id.clone(),
        source_id: detail.post.source_id.clone(),
        source_name: detail.source_name.clone(),
        author_id: detail.post.author_id.clone(),
        author_name: detail
            .author_name
            .clone()
            .unwrap_or_else(|| "Ẩn danh".to_string()),
        permalink: detail.post.permalink.clone(),
        text: detail.post.text.clone(),
        text_truncated: detail.post.text_truncated,
        lang: detail.post.lang.clone(),
        created_at: detail.post.created_at,
        captured_at: detail.post.captured_at,
        strategy: detail.post.strategy.clone(),
        purged_at: detail.post.purged_at,
    }
}
