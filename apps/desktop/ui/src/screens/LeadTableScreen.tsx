import React, { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import {
  formatExactTime,
  formatExtractedFieldValue,
  LEAD_STATUS_LABELS,
} from "../lib/format";
import type {
  DynamicFieldFilter,
  FieldDef,
  FilterOperator,
  Lead,
  LeadFilterQuery,
  LeadStatus,
  LicenseStatus,
  Radar,
} from "../types/ipc";
import { LeadDetailPanel } from "../components/LeadDetailPanel";

const OPERATOR_LABELS: Record<FilterOperator, string> = {
  eq: "= Bằng",
  ne: "≠ Khác",
  lte: "≤ Nhỏ hơn hoặc bằng",
  lt: "< Nhỏ hơn",
  gte: "≥ Lớn hơn hoặc bằng",
  gt: "> Lớn hơn",
  between: "↔ Trong khoảng (từ, đến)",
  in: "∈ Thuộc danh sách (phẩy)",
  contains: "⊃ Chứa chuỗi",
  is_empty: "∅ Đang trống",
};

interface FilterDraftRow {
  id: string;
  field: string;
  op: FilterOperator;
  rawInput: string;
  rawInputMax: string;
}

interface LeadTableScreenProps {
  radars: Radar[];
  license: LicenseStatus;
  refreshToken: number;
  onLeadChanged: () => void;
}

export const LeadTableScreen: React.FC<LeadTableScreenProps> = ({
  radars,
  license,
  refreshToken,
  onLeadChanged,
}) => {
  const [selectedRadarId, setSelectedRadarId] = useState<string>(radars[0]?.id ?? "");
  const [radarFields, setRadarFields] = useState<FieldDef[]>([]);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<LeadStatus | "all">("all");
  const [filterRows, setFilterRows] = useState<FilterDraftRow[]>([]);
  const [sortBy, setSortBy] = useState<string>("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [cursor, setCursor] = useState<string | null>(null);

  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [activeLeadId, setActiveLeadId] = useState<string | null>(null);

  const [includePostText, setIncludePostText] = useState<boolean>(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedRadarId && radars[0]) {
      setSelectedRadarId(radars[0].id);
    }
  }, [radars, selectedRadarId]);

  useEffect(() => {
    if (!selectedRadarId) {
      setRadarFields([]);
      return;
    }
    void api.radarGet(selectedRadarId).then((detail) => {
      const sorted = [...detail.current_version_data.fields].sort((a, b) => a.order - b.order);
      setRadarFields(sorted);
      setFilterRows([]);
      setCursor(null);
    });
  }, [selectedRadarId]);

  const buildFilterQuery = useCallback(
    (pageCursor: string | null): LeadFilterQuery => {
      const dynamicFilters: DynamicFieldFilter[] = filterRows
        .filter((row) => row.field && (row.op === "is_empty" || row.rawInput.trim() !== ""))
        .map((row) => {
          const fd = radarFields.find((f) => f.key === row.field);
          const isNumericField =
            fd?.type === "money" || fd?.type === "number" || fd?.type === "range";

          if (row.op === "is_empty") {
            return { field: row.field, op: "is_empty", value: true };
          }
          if (row.op === "between") {
            return {
              field: row.field,
              op: "between",
              value: [Number(row.rawInput) || 0, Number(row.rawInputMax) || 0],
            };
          }
          if (row.op === "in") {
            return {
              field: row.field,
              op: "in",
              value: row.rawInput
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            };
          }
          if (
            isNumericField &&
            (row.op === "lte" ||
              row.op === "lt" ||
              row.op === "gte" ||
              row.op === "gt" ||
              row.op === "eq")
          ) {
            return { field: row.field, op: row.op, value: Number(row.rawInput) };
          }
          return { field: row.field, op: row.op, value: row.rawInput.trim() };
        });

      return {
        radar_id: selectedRadarId || null,
        status: statusFilter === "all" ? undefined : [statusFilter],
        include_weak: true,
        filters: dynamicFilters,
        search: search.trim() || null,
        sort: { by: sortBy, dir: sortDir },
        limit: 25,
        cursor: pageCursor,
      };
    },
    [selectedRadarId, statusFilter, filterRows, radarFields, search, sortBy, sortDir]
  );

  const loadTable = useCallback(async () => {
    if (!selectedRadarId) {
      setLeads([]);
      setTotal(0);
      return;
    }
    const res = await api.leadList(buildFilterQuery(cursor));
    setLeads(res.items);
    setTotal(res.total);
    setNextCursor(res.next_cursor);
  }, [selectedRadarId, buildFilterQuery, cursor]);

  useEffect(() => {
    void loadTable();
  }, [loadTable, refreshToken]);

  const toggleSort = (col: string) => {
    setCursor(null);
    if (sortBy === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(col);
      setSortDir("desc");
    }
  };

  const addFilterRow = () => {
    const defaultField = radarFields[0]?.key ?? "";
    if (!defaultField) return;
    setFilterRows((prev) => [
      ...prev,
      {
        id: `flt-${Date.now()}-${prev.length}`,
        field: defaultField,
        op: "eq",
        rawInput: "",
        rawInputMax: "",
      },
    ]);
  };

  const handleExport = async (format: "csv" | "xlsx") => {
    setExportMsg(null);
    const res = await api.leadExport({
      query: buildFilterQuery(null),
      format,
      include_post_text: includePostText,
    });
    setExportMsg(
      `Đã xuất ${res.row_count} tin sang định dạng ${format.toUpperCase()}: ${res.path}`
    );
  };

  return (
    <div>
      <div className="screen-header">
        <div>
          <h1 className="screen-title">Bảng tin (CRM Động)</h1>
          <p className="screen-subtitle">
            Cột tự động hiển thị theo các trường của Radar đang chọn · Lọc sâu & Xuất CSV / XLSX
          </p>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12.5 }}>
            <input
              type="checkbox"
              checked={includePostText}
              onChange={(e) => setIncludePostText(e.target.checked)}
            />
            <span>Kèm nội dung bài gốc</span>
          </label>
          <button type="button" className="btn" onClick={() => void handleExport("csv")}>
            ⬇ Xuất CSV
          </button>
          <button
            type="button"
            className="btn btn-primary"
            title={
              license.limits.allow_xlsx_export
                ? "Xuất Excel XLSX"
                : "Xuất XLSX (Gói Chuyên nghiệp)"
            }
            onClick={() => void handleExport("xlsx")}
          >
            ⬇ Xuất XLSX
          </button>
        </div>
      </div>

      {exportMsg && (
        <div className="health-banner info" style={{ borderRadius: 6, marginBottom: 12 }}>
          <span>{exportMsg}</span>
        </div>
      )}

      {/* Primary Toolbar */}
      <div className="toolbar-row">
        <select
          aria-label="Chọn Radar cho Bảng tin"
          className="select"
          style={{ width: 260 }}
          value={selectedRadarId}
          onChange={(e) => setSelectedRadarId(e.target.value)}
        >
          {radars.map((r) => (
            <option key={r.id} value={r.id}>
              Radar: {r.name}
            </option>
          ))}
        </select>

        <select
          aria-label="Trạng thái bảng tin"
          className="select"
          style={{ width: 185 }}
          value={statusFilter}
          onChange={(e) => {
            setCursor(null);
            setStatusFilter(e.target.value as LeadStatus | "all");
          }}
        >
          <option value="all">Mọi trạng thái</option>
          {(Object.keys(LEAD_STATUS_LABELS) as LeadStatus[]).map((st) => (
            <option key={st} value={st}>
              {LEAD_STATUS_LABELS[st]}
            </option>
          ))}
        </select>

        <input
          type="search"
          aria-label="Tìm toàn văn trên Bảng tin"
          className="input"
          style={{ width: 260 }}
          placeholder="Tìm toàn văn nội dung & tóm tắt…"
          value={search}
          onChange={(e) => {
            setCursor(null);
            setSearch(e.target.value);
          }}
        />

        <button
          type="button"
          className="btn"
          disabled={radarFields.length === 0}
          onClick={addFilterRow}
        >
          + Thêm điều kiện lọc theo trường
        </button>

        <span className="field-hint">Tổng cộng: {total.toLocaleString("vi-VN")} tin</span>
      </div>

      {/* Dynamic Field Filter Builder (`03-desktop.md §4`) */}
      {filterRows.length > 0 && (
        <div
          className="card"
          style={{ marginBottom: 12, display: "flex", flexDirection: "column", gap: 8 }}
        >
          {filterRows.map((row, idx) => (
            <div key={row.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <select
                aria-label={`Trường lọc ${idx + 1}`}
                className="select"
                style={{ width: 190 }}
                value={row.field}
                onChange={(e) =>
                  setFilterRows((prev) =>
                    prev.map((r, i) => (i === idx ? { ...r, field: e.target.value } : r))
                  )
                }
              >
                {radarFields.map((fd) => (
                  <option key={fd.key} value={fd.key}>
                    {fd.label}
                  </option>
                ))}
              </select>

              <select
                aria-label={`Toán tử lọc ${idx + 1}`}
                className="select"
                style={{ width: 210 }}
                value={row.op}
                onChange={(e) =>
                  setFilterRows((prev) =>
                    prev.map((r, i) =>
                      i === idx ? { ...r, op: e.target.value as FilterOperator } : r
                    )
                  )
                }
              >
                {(Object.keys(OPERATOR_LABELS) as FilterOperator[]).map((op) => (
                  <option key={op} value={op}>
                    {OPERATOR_LABELS[op]}
                  </option>
                ))}
              </select>

              {row.op !== "is_empty" && (
                <input
                  type="text"
                  aria-label={`Giá trị lọc ${idx + 1}`}
                  className="input"
                  style={{ width: 210 }}
                  placeholder={
                    row.op === "in"
                      ? "Cầu Giấy, Nam Từ Liêm"
                      : row.op === "lte"
                        ? "15000000"
                        : "Nhập giá trị…"
                  }
                  value={row.rawInput}
                  onChange={(e) =>
                    setFilterRows((prev) =>
                      prev.map((r, i) => (i === idx ? { ...r, rawInput: e.target.value } : r))
                    )
                  }
                />
              )}

              {row.op === "between" && (
                <input
                  type="text"
                  aria-label={`Giá trị đến ${idx + 1}`}
                  className="input"
                  style={{ width: 160 }}
                  placeholder="Giá trị đến…"
                  value={row.rawInputMax}
                  onChange={(e) =>
                    setFilterRows((prev) =>
                      prev.map((r, i) => (i === idx ? { ...r, rawInputMax: e.target.value } : r))
                    )
                  }
                />
              )}

              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setFilterRows((prev) => prev.filter((_, i) => i !== idx))}
              >
                Xoá
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Dynamic Columns Table */}
      <div className="table-wrap">
        <table className="crm-table" data-testid="dynamic-lead-table">
          <thead>
            <tr>
              <th className="sortable" onClick={() => toggleSort("created_at")}>
                Thời gian {sortBy === "created_at" ? (sortDir === "asc" ? "↑" : "↓") : ""}
              </th>
              <th className="sortable" onClick={() => toggleSort("score")}>
                Điểm {sortBy === "score" ? (sortDir === "asc" ? "↑" : "↓") : ""}
              </th>
              <th>Trạng thái</th>
              {radarFields.map((fd) => (
                <th
                  key={fd.key}
                  className="sortable"
                  onClick={() => toggleSort(fd.key)}
                >
                  {fd.label} {sortBy === fd.key ? (sortDir === "asc" ? "↑" : "↓") : ""}
                </th>
              ))}
              <th>Tóm tắt</th>
              <th>Group & Tác giả</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => (
              <tr
                key={lead.id}
                style={{ cursor: "pointer" }}
                onClick={() => setActiveLeadId(lead.id)}
              >
                <td style={{ whiteSpace: "nowrap" }}>{formatExactTime(lead.post_created_at)}</td>
                <td>
                  <span className={`badge ${lead.is_weak_match ? "badge-warning" : "badge-success"}`}>
                    {(lead.score * 100).toFixed(0)}%
                  </span>
                </td>
                <td>
                  <span className="badge">{LEAD_STATUS_LABELS[lead.status]}</span>
                </td>
                {radarFields.map((fd) => (
                  <td key={fd.key}>{formatExtractedFieldValue(fd, lead.fields[fd.key])}</td>
                ))}
                <td style={{ maxWidth: 280 }}>{lead.summary}</td>
                <td>
                  <div>{lead.author_name}</div>
                  <div className="field-hint">{lead.source_name}</div>
                </td>
              </tr>
            ))}
            {leads.length === 0 && (
              <tr>
                <td colSpan={5 + radarFields.length} style={{ textAlign: "center", padding: 24 }}>
                  Không có tin nào khớp với điều kiện lọc hiện tại.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10 }}>
        <button
          type="button"
          className="btn btn-sm"
          disabled={!cursor}
          onClick={() => setCursor(null)}
        >
          ← Về trang đầu
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={!nextCursor}
          onClick={() => setCursor(nextCursor)}
        >
          Trang tiếp theo →
        </button>
      </div>

      {/* Slide-over Lead Detail Modal */}
      {activeLeadId && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Chi tiết tin từ Bảng tin">
          <div className="modal-panel" style={{ maxWidth: 820 }}>
            <div className="modal-body">
              <LeadDetailPanel
                leadId={activeLeadId}
                onClose={() => setActiveLeadId(null)}
                onUpdated={() => {
                  void loadTable();
                  onLeadChanged();
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
