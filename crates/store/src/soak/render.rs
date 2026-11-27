//! Markdown rendering of a soak report, in Vietnamese, for pasting into the validation notes.

use std::fmt::Write;

use super::*;

fn minutes(ms: Option<i64>) -> String {
    ms.map(|v| format!("{:.1} phút", v as f64 / MINUTE_MS as f64))
        .unwrap_or_else(|| "—".to_string())
}

fn pct(v: Option<f64>) -> String {
    v.map(|v| format!("{:.1}%", v * 100.0))
        .unwrap_or_else(|| "—".to_string())
}

fn verdict(ok: Option<bool>) -> &'static str {
    match ok {
        Some(true) => "ĐẠT",
        Some(false) => "KHÔNG ĐẠT",
        None => "chưa đủ dữ liệu",
    }
}

fn dist(d: &Distribution) -> String {
    if d.count == 0 {
        return "—".to_string();
    }
    format!(
        "n={} · trung vị {} · p90 {} · p95 {} · lớn nhất {}",
        d.count,
        minutes(d.p50),
        minutes(d.p90),
        minutes(d.p95),
        minutes(d.max)
    )
}

fn map(m: &BTreeMap<String, i64>) -> String {
    if m.is_empty() {
        return "—".to_string();
    }
    m.iter()
        .map(|(k, v)| format!("{k}: {v}"))
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn render_markdown(r: &SoakReport) -> String {
    let mut o = String::new();
    let title = r.label.as_deref().unwrap_or("Không đặt tên");
    let _ = writeln!(o, "# Báo cáo chạy dài ngày: {title}\n");
    let _ = writeln!(
        o,
        "Khoảng đo: {} ngày (từ {} đến {}, mili giây epoch). Lược đồ dữ liệu v{}.\n",
        format_args!("{:.2}", r.window.days),
        r.window.from_ms,
        r.window.until_ms,
        r.schema_version
    );
    let _ = writeln!(
        o,
        "Báo cáo chỉ gồm số liệu và mã định danh, không có nội dung bài hay thông tin liên hệ.\n"
    );
    for w in &r.warnings {
        let _ = writeln!(o, "> Lưu ý: {w}");
    }
    if !r.warnings.is_empty() {
        o.push('\n');
    }

    let c = &r.collection;
    let _ = writeln!(o, "## 1. Bài thu\n");
    let _ = writeln!(o, "| Số liệu | Giá trị |\n|---|---|");
    let _ = writeln!(o, "| Group đang theo dõi | {} |", c.sources_followed);
    let _ = writeln!(
        o,
        "| Bài thu | {} ({:.1} bài/ngày) |",
        c.posts_captured, c.posts_per_day
    );
    let _ = writeln!(
        o,
        "| Bài duy nhất | {} (trùng giữa các group: {}) |",
        c.unique_posts, c.duplicate_posts
    );
    let _ = writeln!(
        o,
        "| Lần quét | {} ({}), tải trang {} |",
        c.crawl.runs,
        map(&c.crawl.by_status),
        c.crawl.page_loads
    );
    let _ = writeln!(o, "| Từ lúc đăng đến lúc thu | {} |", dist(&c.capture_lag));
    if !c.crawl.longest_gaps.is_empty() {
        o.push_str("\nKhoảng dài nhất không có lần quét thành công:\n\n");
        for g in &c.crawl.longest_gaps {
            let _ = writeln!(o, "- {}: {}", g.name, minutes(Some(g.longest_gap_ms)));
        }
    }
    if !c.per_source.is_empty() {
        o.push_str("\n| Group | Bài thu | Bài duy nhất | Bài/ngày |\n|---|---|---|---|\n");
        for s in &c.per_source {
            let _ = writeln!(
                o,
                "| {} | {} | {} | {:.1} |",
                s.name, s.posts, s.unique_posts, s.posts_per_day
            );
        }
    }

    let e = &r.evaluation;
    let _ = writeln!(o, "\n## 2. Cặp bài–Radar cần chấm\n");
    let _ = writeln!(o, "| Số liệu | Giá trị |\n|---|---|");
    let _ = writeln!(o, "| Cặp bài–Radar đã chấm | {} |", e.pairs_evaluated);
    let _ = writeln!(o, "| Theo tầng quyết định | {} |", map(&e.by_decided_by));
    let _ = writeln!(o, "| Theo trạng thái | {} |", map(&e.by_state));
    let _ = writeln!(o, "| Cặp cần AI | {} |", e.pairs_needing_ai);
    let _ = writeln!(
        o,
        "| Bài duy nhất cần AI / bài duy nhất đã thu | {} / {} = {} |",
        e.unique_posts_needing_ai,
        c.unique_posts,
        pct(e.ai_share_of_unique_posts)
    );
    let _ = writeln!(
        o,
        "| Đang chờ AI / lỗi AI lúc báo cáo | {} / {} |",
        e.pending_ai_now, e.ai_failed_now
    );
    let _ = writeln!(
        o,
        "| Có thể bị sót (cần kiểm tra) | {} |",
        e.possibly_missed_pairs
    );
    if !e.per_radar.is_empty() {
        o.push_str("\n| Radar | Cặp đã chấm | Cặp cần AI | Bài duy nhất cần AI | Luật hoạt động từ |\n|---|---|---|---|---|\n");
        for rl in &e.per_radar {
            let _ = writeln!(
                o,
                "| {} | {} | {} | {} | {} |",
                rl.radar_name,
                rl.pairs_evaluated,
                rl.pairs_needing_ai,
                rl.unique_posts_needing_ai,
                rl.rules_active_from_ms
                    .map(|t| t.to_string())
                    .unwrap_or_else(|| "chưa có".into())
            );
        }
    }
    if !e.per_day.is_empty() {
        o.push_str("\n| Ngày | Bài duy nhất thu | Cặp đã chấm | Cặp cần AI | Lần gọi AI |\n|---|---|---|---|---|\n");
        for d in &e.per_day {
            let _ = writeln!(
                o,
                "| {} | {} | {} | {} | {} |",
                d.day, d.posts_captured, d.pairs_evaluated, d.pairs_needing_ai, d.ai_calls
            );
        }
    }

    let ru = &r.rules;
    let _ = writeln!(
        o,
        "\n## 3. Sau khi bộ luật hoạt động (mục tiêu ≤ {})\n",
        pct(Some(ru.target))
    );
    let _ = writeln!(o, "| Số liệu | Giá trị |\n|---|---|");
    let _ = writeln!(
        o,
        "| Radar có / chưa có luật | {} / {} |",
        ru.radars_with_rules, ru.radars_without_rules
    );
    let _ = writeln!(
        o,
        "| Luật hoạt động từ (sớm nhất) | {} |",
        ru.rules_active_from_ms
            .map(|t| t.to_string())
            .unwrap_or_else(|| "chưa có".into())
    );
    let _ = writeln!(
        o,
        "| Bài duy nhất cần AI / bài duy nhất đã thu | {} / {} = {} |",
        ru.unique_posts_needing_ai,
        ru.unique_posts_captured,
        pct(ru.ai_share_of_unique_posts)
    );
    let _ = writeln!(o, "| Kết luận | {} |", verdict(ru.meets_target));

    let a = &r.ai;
    let _ = writeln!(o, "\n## 4. Lượng AI\n");
    let _ = writeln!(o, "| Số liệu | Giá trị |\n|---|---|");
    let _ = writeln!(o, "| Lần gọi AI | {} ({}) |", a.calls, map(&a.by_status));
    let _ = writeln!(o, "| Theo tác vụ | {} |", map(&a.by_task));
    let _ = writeln!(o, "| Theo nhà cung cấp | {} |", map(&a.by_provider));
    let _ = writeln!(o, "| Số bài trong các lần gọi | {} |", a.items);
    let _ = writeln!(
        o,
        "| Token vào / ra | {} / {} |",
        a.input_tokens, a.output_tokens
    );
    let _ = writeln!(o, "| Lần chạm hạn mức | {} |", a.quota_hits);
    let _ = writeln!(o, "| Thời lượng mỗi lần gọi | {} |", dist(&a.duration));
    if a.unattributed_calls > 0 {
        let _ = writeln!(
            o,
            "| Lần gọi không gắn với Radar nào | {} |",
            a.unattributed_calls
        );
    }
    if !a.per_radar.is_empty() {
        o.push_str("\n| Radar | Lần gọi | Bài | Token vào | Token ra | Tỷ lệ bài |\n|---|---|---|---|---|---|\n");
        for x in &a.per_radar {
            let _ = writeln!(
                o,
                "| {} | {} | {} | {} | {} | {} |",
                x.radar_name,
                x.calls,
                x.items,
                x.input_tokens,
                x.output_tokens,
                pct(Some(x.share_of_items))
            );
        }
    }

    let n = &r.notifications;
    let _ = writeln!(o, "\n## 5. Tin báo\n");
    let _ = writeln!(o, "| Số liệu | Giá trị |\n|---|---|");
    let _ = writeln!(o, "| Tin (cơ hội) tạo ra | {} |", n.leads_created);
    let _ = writeln!(
        o,
        "| Đã báo / chưa báo | {} / {} |",
        n.leads_notified, n.leads_not_notified
    );
    let _ = writeln!(
        o,
        "| Thông báo gửi đi | {} (theo trạng thái: {}) |",
        n.messages_sent,
        map(&n.outbox_by_state)
    );
    let _ = writeln!(o, "| Theo kênh | {} |", map(&n.outbox_by_kind));
    let _ = writeln!(o, "| Phải thử lại | {} |", n.messages_retried);
    let _ = writeln!(
        o,
        "| Thất bại hoặc bị bỏ / còn chờ | {} / {} |",
        n.messages_failed_or_dropped, n.messages_still_pending
    );
    let _ = writeln!(
        o,
        "| Gửi trùng cùng một tin tới một kênh | {} tin, thừa {} thông báo |",
        n.duplicates.leads_sent_more_than_once, n.duplicates.extra_messages
    );
    let _ = writeln!(
        o,
        "| Cùng một bài báo cho nhiều Radar trên một kênh | {} bài, thừa {} thông báo |",
        n.duplicates.posts_sent_for_multiple_radars, n.duplicates.extra_messages_across_radars
    );
    if !n.per_radar.is_empty() {
        o.push_str("\n| Radar | Tin | Đã báo | Thông báo gửi |\n|---|---|---|---|\n");
        for x in &n.per_radar {
            let _ = writeln!(
                o,
                "| {} | {} | {} | {} |",
                x.radar_name, x.leads, x.notified, x.messages_sent
            );
        }
    }

    let l = &r.latency;
    let _ = writeln!(
        o,
        "\n## 6. Từ giờ đăng đến lúc gửi tin (trung vị < {} phút)\n",
        l.target_median_ms / MINUTE_MS
    );
    let _ = writeln!(o, "| Số liệu | Giá trị |\n|---|---|");
    let _ = writeln!(o, "| Tin đã gửi đo được | {} |", l.notified_leads);
    let _ = writeln!(o, "| Tổng | {} |", dist(&l.total));
    let _ = writeln!(o, "| Đăng → thu | {} |", dist(&l.capture));
    let _ = writeln!(o, "| Thu → gửi | {} |", dist(&l.processing));
    let _ = writeln!(
        o,
        "| Chậm hơn {} phút | {} tin |",
        l.slow_after_ms / MINUTE_MS,
        l.slow_count
    );
    let _ = writeln!(
        o,
        "| Kết luận trung vị | {} |",
        verdict(l.median_within_target)
    );
    if !l.slowest.is_empty() {
        o.push_str("\nCác tin chậm nhất:\n\n| Tin | Radar | Bài | Tổng | Đăng→thu | Thu→gửi |\n|---|---|---|---|---|---|\n");
        for s in &l.slowest {
            let _ = writeln!(
                o,
                "| {} | {} | {} | {} | {} | {} |",
                s.lead_id,
                s.radar_id,
                s.post_id,
                minutes(Some(s.total_ms)),
                minutes(Some(s.capture_ms)),
                minutes(Some(s.processing_ms))
            );
        }
    }

    if !r.interruptions.is_empty() {
        let _ = writeln!(o, "\n## 7. Đối soát sau gián đoạn\n");
        for i in &r.interruptions {
            let _ = writeln!(
                o,
                "### {} ({} phút){}\n",
                i.kind,
                i.duration_ms / MINUTE_MS,
                i.note
                    .as_deref()
                    .map(|n| format!(" — {n}"))
                    .unwrap_or_default()
            );
            let _ = writeln!(o, "| Số liệu | Giá trị |\n|---|---|");
            let _ = writeln!(
                o,
                "| Bài đăng trong lúc gián đoạn / thu muộn sau đó | {} / {} ({}) |",
                i.posts_published_during,
                i.posts_published_during_captured_late,
                dist(&i.late_capture_lag)
            );
            let _ = writeln!(
                o,
                "| Hàng chờ AI lúc bắt đầu / kết thúc | {} / {} |",
                i.backlog_at_start, i.backlog_at_end
            );
            let _ = writeln!(
                o,
                "| Xử lý hết hàng chờ sau | {} |",
                minutes(i.backlog_drain_ms)
            );
            let _ = writeln!(
                o,
                "| Độ trễ chấm của các lượt tạo trong khoảng | {} |",
                dist(&i.evaluation_delay)
            );
            let _ = writeln!(o, "| Lượt chấm còn dở | {} |", i.evaluations_unresolved_now);
            let _ = writeln!(
                o,
                "| Lần gọi AI trong khoảng | {} |",
                map(&i.ai_calls_during)
            );
            let _ = writeln!(o, "| AI phục hồi sau | {} |", minutes(i.ai_recovery_ms));
            let _ = writeln!(
                o,
                "| Tin tạo trong khoảng / gửi sau khi kết thúc / chưa gửi | {} / {} / {} |",
                i.leads_created_during, i.leads_notified_after_end, i.leads_never_notified
            );
            let _ = writeln!(
                o,
                "| Độ trễ gửi sau khi kết thúc | {} |",
                dist(&i.notification_delay_after_end)
            );
            let _ = writeln!(
                o,
                "| Thông báo thất bại / thử lại / tin gửi trùng | {} / {} / {} |",
                i.messages_failed_or_dropped, i.messages_retried, i.leads_sent_more_than_once
            );
            o.push('\n');
            for f in &i.findings {
                let _ = writeln!(o, "- {f}");
            }
            o.push('\n');
        }
    }
    o
}
