import React from "react";
import type { FunnelStats } from "../types/ipc";

interface FunnelChartProps {
  stats: FunnelStats | null;
  title?: string;
}

export const FunnelChart: React.FC<FunnelChartProps> = ({
  stats,
  title = "Phễu xử lý 7 ngày gần nhất",
}) => {
  if (!stats) {
    return <div className="card text-muted">Đang tải số liệu phễu 7 ngày…</div>;
  }

  const total = Math.max(1, stats.posts_captured);
  const pct = (n: number) => `${Math.round((n / total) * 100)}%`;
  const fpPct =
    stats.leads_notified > 0
      ? `${Math.round((stats.false_positives / stats.leads_notified) * 100)}%`
      : "0%";

  const rows = [
    {
      label: "Bài thu được từ group",
      value: stats.posts_captured,
      sub: "100% đầu vào",
      color: "#334155",
      widthPct: 100,
    },
    {
      label: "├─ Lọc trùng loại (trùng hẳn & SimHash)",
      value: stats.dedup_dropped,
      sub: pct(stats.dedup_dropped),
      color: "#64748b",
      widthPct: Math.min(100, (stats.dedup_dropped / total) * 100),
    },
    {
      label: "├─ Lọc sơ bộ loại (ngắn, danh sách chặn, từ khoá loại)",
      value: stats.prefilter_dropped,
      sub: pct(stats.prefilter_dropped),
      color: "#475569",
      widthPct: Math.min(100, (stats.prefilter_dropped / total) * 100),
    },
    {
      label: "├─ Bộ luật tự quyết định",
      value: stats.rule_decided,
      sub: `${pct(stats.rule_decided)} · trong đó khớp: ${stats.rule_matched.toLocaleString("vi-VN")}`,
      color: "#0284c7",
      widthPct: Math.min(100, (stats.rule_decided / total) * 100),
    },
    {
      label: "└─ Gửi lên AI quyết định",
      value: stats.ai_decided,
      sub: `${pct(stats.ai_decided)} · trong đó khớp: ${stats.ai_matched.toLocaleString("vi-VN")}`,
      color: "#2563eb",
      widthPct: Math.min(100, (stats.ai_decided / total) * 100),
    },
  ];

  return (
    <div className="card">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <strong style={{ fontSize: 14 }}>{title}</strong>
        <span className="badge badge-primary">{stats.days} ngày qua</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map((r) => (
          <div key={r.label}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 12.5,
                marginBottom: 3,
              }}
            >
              <span>{r.label}</span>
              <span>
                <strong>{r.value.toLocaleString("vi-VN")}</strong>{" "}
                <span className="text-muted">({r.sub})</span>
              </span>
            </div>
            <div
              style={{
                height: 6,
                background: "#f1f5f9",
                borderRadius: 4,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${Math.max(2, r.widthPct)}%`,
                  background: r.color,
                  borderRadius: 4,
                }}
              />
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          marginTop: 12,
          paddingTop: 10,
          borderTop: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 10,
          fontSize: 12.5,
        }}
      >
        <div>
          Tin tạo ra: <strong>{stats.leads_created.toLocaleString("vi-VN")}</strong> (đã báo{" "}
          <strong>{stats.leads_notified}</strong>, khớp yếu <strong>{stats.leads_weak}</strong>)
        </div>
        <div>
          Bị đánh dấu sai: <strong>{stats.false_positives}</strong> ({fpPct} số tin đã báo)
        </div>
      </div>
    </div>
  );
};
