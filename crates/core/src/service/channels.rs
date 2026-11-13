//! Telegram, channel, and webhook commands.

use super::*;

impl CoreService {
    pub async fn telegram_set_token(&self, token: &str) -> CoreResult<TelegramSetupStatus> {
        self.ensure_not_shutting_down()?;
        let cleaned = token.trim();
        if cleaned.is_empty() {
            return Err(CoreError::Validation(
                "Telegram bot token cannot be empty".to_string(),
            ));
        }

        let bot_info = self.rt.telegram.get_me(cleaned).await?;
        self.rt
            .secrets
            .set_secret(TELEGRAM_BOT_TOKEN_KEY, cleaned)?;
        self.rt
            .store
            .set_setting("telegram.bot_username", &bot_info.username)?;

        let channels = self.channel_list()?;
        let tg_channels: Vec<_> = channels
            .into_iter()
            .filter(|c| c.kind == "telegram")
            .collect();
        let waiting_for_start = tg_channels.is_empty();

        let _ = self.rt.emit_health_if_changed(now_ms())?;

        Ok(TelegramSetupStatus {
            bot_username: bot_info.username.clone(),
            bot_link: format!("https://t.me/{}?start=dealsonar", bot_info.username),
            waiting_for_start,
            channels: tg_channels,
        })
    }

    pub async fn telegram_test(&self, channel_id: Option<&str>) -> CoreResult<TelegramTestResult> {
        let Some(token) = self.rt.secrets.get_secret(TELEGRAM_BOT_TOKEN_KEY)? else {
            return Ok(TelegramTestResult {
                ok: false,
                message: "Chưa cấu hình Telegram Bot Token".to_string(),
            });
        };

        let all_channels = self.rt.store.channel_list()?;
        let target = match channel_id {
            Some(cid) => all_channels
                .into_iter()
                .find(|c| c.id == cid && c.kind == "telegram"),
            None => all_channels.into_iter().find(|c| c.kind == "telegram"),
        };

        let Some(ch) = target else {
            return Ok(TelegramTestResult {
                ok: false,
                message: "Chưa có kênh Telegram nào gửi /start tới bot".to_string(),
            });
        };

        let Some(chat_id) = ch.config.get("chat_id").and_then(|v| {
            v.as_str()
                .and_then(|s| s.parse::<i64>().ok())
                .or_else(|| v.as_i64())
        }) else {
            return Ok(TelegramTestResult {
                ok: false,
                message: "Cấu hình kênh Telegram thiếu chat_id".to_string(),
            });
        };

        let req = SendMessageRequest::html(
            chat_id,
            "✅ <b>DealSonar</b>: Tin nhắn kiểm tra kết nối Telegram thành công!",
            None,
        );
        match self
            .rt
            .telegram
            .deliver_outbox_message(&token, &req, 0, 0)
            .await
        {
            TelegramDeliveryOutcome::Sent { message_id } => {
                if ch.state != "ok" {
                    let _ = self.rt.store.channel_set_state(&ch.id, "ok");
                    let _ = self.rt.emit_health_if_changed(now_ms());
                }
                Ok(TelegramTestResult {
                    ok: true,
                    message: format!("Đã gửi thành công (message_id={message_id})"),
                })
            }
            TelegramDeliveryOutcome::AuthRevoked => {
                let _ = self.rt.store.channel_set_state(&ch.id, "error");
                let _ = self.rt.emit_health_if_changed(now_ms());
                Ok(TelegramTestResult {
                    ok: false,
                    message: "Bot bị chặn hoặc token đã bị thu hồi (401/403)".to_string(),
                })
            }
            other => Ok(TelegramTestResult {
                ok: false,
                message: format!("Gửi thử thất bại: {other:?}"),
            }),
        }
    }

    pub fn channel_list(&self) -> CoreResult<Vec<Channel>> {
        let records = self.rt.store.channel_list()?;
        let bot_username: Option<String> = self.rt.store.get_setting("telegram.bot_username")?;

        Ok(records
            .into_iter()
            .map(|r| channel_record_to_dto(&r, bot_username.as_deref()))
            .collect())
    }

    pub fn channel_remove(&self, id: &str) -> CoreResult<ChannelRemoveResult> {
        self.ensure_not_shutting_down()?;
        let existing = self.rt.store.channel_get(id)?;
        let removed = self.rt.store.channel_delete(id)?;
        if removed {
            self.rt.remove_channel_from_outbox_tracker(id)?;
        }
        if let Some(ch) = existing {
            if ch.kind == "webhook" {
                let _ = self.rt.secrets.delete_secret(&webhook_channel_key(&ch.id));
            }
        }
        let _ = self.rt.emit_health_if_changed(now_ms())?;
        Ok(ChannelRemoveResult { removed })
    }

    pub fn webhook_add(&self, name: &str, url: &str, secret: Option<&str>) -> CoreResult<Channel> {
        self.ensure_not_shutting_down()?;
        let now = monotonic_radar_now_ms();
        let license = self.rt.current_license_status(now)?;
        if !license.limits.allow_webhooks {
            return Err(CoreError::LicenseLimitExceeded(
                "Webhook channels require the Pro (Chuyên nghiệp) plan".to_string(),
            ));
        }
        if name.trim().is_empty() {
            return Err(CoreError::Validation(
                "Webhook channel name cannot be empty".to_string(),
            ));
        }

        let validated_url = validate_webhook_url(url)?;
        let effective_secret = match secret.map(str::trim).filter(|s| !s.is_empty()) {
            Some(s) => s.to_string(),
            None => generate_webhook_secret(),
        };

        let cfg = json!({
            "url": validated_url.as_str(),
            "include_post_text": false,
        });
        let created = self
            .rt
            .store
            .channel_create("webhook", name.trim(), &cfg, now)?;
        self.rt
            .secrets
            .set_secret(&webhook_channel_key(&created.id), &effective_secret)?;

        let bot_username: Option<String> = self.rt.store.get_setting("telegram.bot_username")?;
        Ok(channel_record_to_dto(&created, bot_username.as_deref()))
    }
}

// ============================================================================
// Internal DTO Helpers
// ============================================================================

pub(super) fn generate_webhook_secret() -> String {
    use rand::RngCore;
    let mut raw = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut raw);
    let mut hex = String::with_capacity(6 + raw.len() * 2);
    hex.push_str("whsec_");
    for b in raw {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{b:02x}");
    }
    hex
}

pub(super) fn channel_record_to_dto(
    r: &dealsonar_store::models::ChannelRecord,
    bot_username: Option<&str>,
) -> Channel {
    let chat_id = r.config.get("chat_id").and_then(|v| {
        v.as_str()
            .map(str::to_string)
            .or_else(|| v.as_i64().map(|n| n.to_string()))
    });
    let chat_type = r
        .config
        .get("chat_type")
        .and_then(Value::as_str)
        .map(str::to_string);
    let url = r
        .config
        .get("url")
        .and_then(Value::as_str)
        .map(str::to_string);

    Channel {
        id: r.id.clone(),
        kind: r.kind.clone(),
        name: r.name.clone(),
        config: ChannelConfig {
            chat_id,
            bot_username: (r.kind == "telegram")
                .then(|| bot_username.map(str::to_string))
                .flatten(),
            chat_type,
            url,
        },
        state: r.state.clone(),
        last_error: (r.state == "error").then(|| "Channel delivery failed".to_string()),
        created_at: r.created_at,
    }
}
