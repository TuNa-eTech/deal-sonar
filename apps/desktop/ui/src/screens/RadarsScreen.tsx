import { offerUndo } from "../components/UndoCenter";
import React, { useEffect, useState } from "react";
import {VersionHistory} from "../components/VersionHistory";
import { api } from "../lib/api";
import { formatLifetime, RADAR_STATUS_LABELS } from "../lib/format";
import type {
  FunnelStats,
  LicenseStatus,
  Radar,
  RadarDetail,
  Ruleset,
} from "../types/ipc";
import { FunnelChart } from "../components/FunnelChart";
import { RadarCompareDialog } from "../components/RadarCompareDialog";
import { RadarVariantDialog } from "../components/RadarVariantDialog";
import { Badge, Button, Card, Input } from "../components/ui";

interface RadarsScreenProps {
  radars: Radar[];
  license: LicenseStatus;
  onCreateNew: () => void;
  onEditRadar: (detail: RadarDetail, step?: 1 | 3 | 4) => void;
  onChanged: () => void;
}

export const RadarsScreen: React.FC<RadarsScreenProps> = ({
  radars,
  license,
  onCreateNew,
  onEditRadar,
  onChanged,
}) => {
  const [selectedId, setSelectedId] = useState<string>(radars[0]?.id ?? "");
  const [funnel, setFunnel] = useState<FunnelStats | null>(null);
  const [rulesets, setRulesets] = useState<Ruleset[]>([]);
  const [detail, setDetail] = useState<RadarDetail | null>(null);

  const [acceptKws, setAcceptKws] = useState<string>("");
  const [rejectKws, setRejectKws] = useState<string>("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [variantOf, setVariantOf] = useState<string | null>(null);
  const [compareFrom, setCompareFrom] = useState<string | null>(null);

  useEffect(() => {
    if (!radars.some(r => r.id === selectedId)) {
      setSelectedId(radars[0]?.id ?? "");
      setDetail(null);
      setFunnel(null);
    }
  }, [radars, selectedId]);

  const loadInspector = async (radarId: string) => {
    if (!radarId) return;
    const [fStats, rsList, rDetail] = await Promise.all([
      api.radarStats(radarId, 7),
      api.rulesetList(radarId),
      api.radarGet(radarId),
    ]);
    setFunnel(fStats);
    setRulesets(rsList);
    setDetail(rDetail);
    const activeRs = rsList.find((r) => r.state === "active") ?? rsList[0];
    if (activeRs) {
      setAcceptKws(activeRs.body.prefilter.any.join(", "));
      setRejectKws(activeRs.body.prefilter.none.join(", "));
    } else {
      setAcceptKws("");
      setRejectKws("");
    }
  };

  useEffect(() => {
    if (selectedId) {
      void loadInspector(selectedId);
    }
  }, [selectedId, radars]);

  const handleToggleStatus = async (r: Radar) => {
    setErrorMsg(null);
    try {
      if (r.status === "draft" || (r.status === "paused" && !r.source_ids.length)) {
        const step = r.status === "draft" && r.source_ids.length ? 4 : 3;
        onEditRadar(await api.radarGet(r.id), step);
        return;
      }
      const next = r.status === "active" ? "paused" : "active";
      await api.radarSetStatus(r.id, next);
      onChanged();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleArchive = async (r: Radar) => {
    try {
      await api.radarSetStatus(r.id, "archived");
      offerUndo(`Đã lưu trữ và ngừng radar ${r.name}`, async () => {
        await api.radarSetStatus(r.id, r.status);
        onChanged();
      });
      onChanged();
    } catch (error) {
      setErrorMsg(String(error));
    }
  };

  const handleSaveUserKeywords = async () => {
    if (!detail) return;
    setErrorMsg(null);
    const currentRs = rulesets.find((r) => r.state === "active") ?? rulesets[0];
    const baseBody = currentRs?.body ?? {
      dsl: 1 as const,
      prefilter: { any: [], none: [], min_len: 20 },
      classify: [],
      extract: [],
      thresholds: { accept: 0.9, reject: 0.9 },
    };

    const updatedBody = {
      ...baseBody,
      prefilter: {
        ...baseBody.prefilter,
        any: acceptKws
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        none: rejectKws
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      },
    };

    const saved = await api.rulesetSaveUser(
      detail.radar.id,
      detail.current_version_data.id,
      updatedBody
    );
    setStatusMsg(
      `Đã lưu bộ luật người dùng (phiên bản r${saved.revision}, origin: "${saved.origin}") và đưa qua cổng kiểm định!`
    );
    await loadInspector(detail.radar.id);
  };

  const activeCount = radars.filter((r) => r.status === "active").length;
  const maxActive = license.limits.max_active_radars;
  const activeRuleset = rulesets.find((r) => r.state === "active") ?? rulesets[0] ?? null;
  const rulePct = activeRuleset?.metrics?.rule_handled_pct ?? 0;
  const aiPct = activeRuleset ? 100 - rulePct : 100;

  return (
    <div className="radars-workspace">
      <div className="screen-header">
        <div>
          <h1 className="screen-title">Quản lý Radar</h1>
          <p className="screen-subtitle">
            Đang chạy {activeCount} / {maxActive === null ? "Không giới hạn" : maxActive} radar (Gói{" "}
            {license.plan === "pro" ? "Chuyên nghiệp" : "Cá nhân"})
          </p>
        </div>
        <Button variant="primary" onClick={onCreateNew}>
          + Tạo radar mới
        </Button>
      </div>

      {variantOf && (
        <RadarVariantDialog
          sourceRadarId={variantOf}
          license={license}
          onClose={() => setVariantOf(null)}
          onCreated={(created) => {
            setVariantOf(null);
            setErrorMsg(null);
            setSelectedId(created.radar.id);
            setStatusMsg(
              `Đã tạo biến thể “${created.radar.name}” ở trạng thái bản nháp, chưa gửi thông báo. Chọn nguồn, xem thử rồi bật khi sẵn sàng.`
            );
            onChanged();
          }}
        />
      )}

      {compareFrom && (
        <RadarCompareDialog
          radars={radars}
          initialLeftId={compareFrom}
          onClose={() => setCompareFrom(null)}
        />
      )}

      {errorMsg && (
        <div className="health-banner danger" style={{ borderRadius: 6, marginBottom: 12 }}>
          <span>{errorMsg}</span>
        </div>
      )}
      {statusMsg && (
        <div className="health-banner info" style={{ borderRadius: 6, marginBottom: 12 }}>
          <span>{statusMsg}</span>
        </div>
      )}

      {/* Radar List Table */}
      <div className="table-wrap radar-directory">
        <table className="crm-table">
          <thead>
            <tr>
              <th>Tên Radar</th>
              <th>Trạng thái</th>
              <th>Tin còn giá trị</th>
              <th>Nguồn</th>
              <th>Tin 24 giờ</th>
              <th>Tỉ lệ báo sai</th>
              <th>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {radars.map((r) => (
              <tr
                key={r.id}
                style={{
                  background: selectedId === r.id ? "var(--bg-subtle)" : undefined,
                  boxShadow: selectedId === r.id ? "inset 3px 0 0 var(--primary)" : undefined,
                  cursor: "pointer",
                }}
                onClick={() => setSelectedId(r.id)}
              >
                <td>
                  <button type="button" className="radar-name-button" aria-pressed={selectedId === r.id} onClick={() => setSelectedId(r.id)}>{r.name}</button>
                  {r.variant_of && (
                    <div className="field-hint">
                      Biến thể của {radars.find((o) => o.id === r.variant_of)?.name ?? "Radar gốc đã lưu trữ"}
                    </div>
                  )}
                </td>
                <td>
                  <span
                    className={`badge ${
                      r.status === "active"
                        ? "badge-success"
                        : r.status === "paused"
                          ? "badge-warning"
                          : ""
                    }`}
                  >
                    {RADAR_STATUS_LABELS[r.status]}
                  </span>
                </td>
                <td title={`Phiên bản định nghĩa v${r.current_version}`}>{formatLifetime(r.notify.lead_ttl_hours)}</td>
                <td>{r.source_ids.length} group</td>
                <td>{(r.leads_24h ?? 0).toLocaleString("vi-VN")} tin</td>
                <td>{Math.round((r.false_positive_rate ?? 0) * 100)}%</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <div className="management-row-actions">
                    <Button
                      size="sm"
                      onClick={async () => {
                        const d = await api.radarGet(r.id);
                        onEditRadar(d, 1);
                      }}
                    >
                      Sửa
                    </Button>
                    {r.status !== "draft" && <Button
                      size="sm"
                      onClick={async () => {
                        const d = await api.radarGet(r.id);
                        onEditRadar(d, 4);
                      }}
                    >
                      Xem thử lại
                    </Button>}
                    <Button
                      size="sm"
                      onClick={() => void handleToggleStatus(r)}
                    >
                      {r.status === "active" ? "Tạm dừng" : r.status === "draft"
                        ? (r.source_ids.length ? "Xem kết quả" : "Chọn nguồn") : "Chạy lại"}
                    </Button>
                    <Button size="sm" onClick={() => setVariantOf(r.id)}>
                      Tạo biến thể
                    </Button>
                    <Button size="sm" onClick={() => setCompareFrom(r.id)}>
                      So sánh
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void handleArchive(r)}
                    >
                      Lưu trữ
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detail?.radar.id === selectedId && <VersionHistory key={detail.radar.id+detail.radar.current_version} detail={detail} onChanged={()=>{onChanged();void loadInspector(detail.radar.id);}}/>}
      {/* Selected Radar Funnel & Ruleset Inspector (`05-pipeline-rules.md §6.5, §11`) */}
      {detail?.radar.id === selectedId && (
        <div className="radar-inspector">
          <FunnelChart
            stats={funnel}
            title={`Phễu 7 ngày: ${detail.radar.name}`}
          />

          <Card className="radar-rules">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ fontSize: 14 }}>Bộ luật tự động (Ruleset)</strong>
              {activeRuleset ? (
                <Badge tone="success">
                  r{activeRuleset.revision}, {activeRuleset.state}, nguồn: {activeRuleset.origin}
                </Badge>
              ) : (
                <Badge >Chưa có bộ luật (100% qua AI)</Badge>
              )}
            </div>

            <p style={{ margin: "8px 0 12px", fontWeight: 600, color: "var(--primary-hover)" }}>
              Bộ luật đang tự xử lý {rulePct}% số bài, AI xử lý {aiPct}%
            </p>

            {activeRuleset && (
              <div style={{ marginBottom: 12, fontSize: 12.5 }}>
                <div style={{ marginBottom: 6 }}>
                  <strong>Bộ trích trường tự động đang bật:</strong>{" "}
                  {activeRuleset.body.extract.map((ex) => (
                    <Badge key={ex.field}  style={{ marginRight: 4 }}>
                      {ex.field} ({ex.extractor})
                    </Badge>
                  ))}
                </div>
                {activeRuleset.body.classify.length > 0 && (
                  <div>
                    <strong>Luật phân loại ({activeRuleset.body.classify.length}):</strong>
                    <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                      {activeRuleset.body.classify.map((c) => (
                        <li key={c.id}>
                          [{c.verdict === "match" ? "Khớp" : "Loại"} ≥{" "}
                          {Math.round(c.confidence * 100)}%]{" "}
                          {c.description ?? (c.kw_any ?? []).join(", ")}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            <div className="field-group">
              <label className="field-label" htmlFor="rs-accept-kw">
                Từ khoá nhận sơ bộ (không dấu, cách nhau dấu phẩy)
              </label>
              <Input
                id="rs-accept-kw"
                type="text"
                value={acceptKws}
                onChange={(e) => setAcceptKws(e.target.value)}
                placeholder="can thue, tim thue, muon thue"
              />
            </div>

            <div className="field-group">
              <label className="field-label" htmlFor="rs-reject-kw">
                Từ khoá loại ngay (không dấu, cách nhau dấu phẩy)
              </label>
              <Input
                id="rs-reject-kw"
                type="text"
                value={rejectKws}
                onChange={(e) => setRejectKws(e.target.value)}
                placeholder="quy can, hoa hong, tuyen sale"
              />
            </div>

            <div className="management-row-actions">
              <Button
                variant="primary" size="sm"
                onClick={() => void handleSaveUserKeywords()}
              >
                Lưu chỉnh sửa từ khoá (`origin: user`)
              </Button>
              <Button
                size="sm"
                onClick={async () => {
                  await api.rulesetCompileNow(detail.radar.id);
                  setStatusMsg("Đã xếp lịch sinh bộ luật mới bằng AI từ dữ liệu phản hồi.");
                  await loadInspector(detail.radar.id);
                }}
              >
                Sinh lại bộ luật bằng AI
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};
