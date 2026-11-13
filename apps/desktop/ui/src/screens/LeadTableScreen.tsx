import React, { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace } from "../lib/workspace";
import { parseVietnameseNumber } from "../lib/fieldValues";
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
  const [selectedRadarId, setSelectedRadarId] = useWorkspace<string>("opportunity-radar", "");
  const [radarFields, setRadarFields] = useState<FieldDef[]>([]);

  const [search, setSearch] = useWorkspace("opportunity-search", "");
  const [statusFilter, setStatusFilter] = useWorkspace<LeadStatus | "all">("opportunity-status", "all");
  const [filterRows, setFilterRows] = useWorkspace<FilterDraftRow[]>("opportunity-filters",[]);
  const [includeWeak,setIncludeWeak]=useWorkspace("opportunity-weak",false);
  const [unread,setUnread]=useWorkspace("opportunity-unread",false);
  const [hiddenColumns,setHiddenColumns]=useWorkspace<string[]>("opportunity-hidden-columns",[]);
  const [selectedRows,setSelectedRows]=useState<string[]>([]);
  const [error,setError]=useState<string|null>(null);
  const [loading,setLoading]=useState(false);
  const [pageHistory,setPageHistory]=useState<(string|null)[]>([]);
  const seq=useRef(0);
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
    if (!selectedRadarId) {
      setRadarFields([]);
      return;
    }
    let cancelled=false;
    void api.radarGet(selectedRadarId).then((detail) => {
      if(cancelled)return;
      const sorted = [...detail.current_version_data.fields].sort((a, b) => a.order - b.order);
      setRadarFields(sorted);
      setCursor(null);
    }).catch(e=>setError(String(e)));
    return()=>{cancelled=true;};
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
              value: (()=>{const a=parseVietnameseNumber(row.rawInput),b=parseVietnameseNumber(row.rawInputMax);if(a>b)throw new Error("Khoảng lọc: giá trị từ không được lớn hơn giá trị đến.");return [a,b];})(),
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
              row.op === "eq" || row.op === "ne")
          ) {
            return { field: row.field, op: row.op, value: parseVietnameseNumber(row.rawInput) };
          }
          return { field: row.field, op: row.op, value: row.rawInput.trim() };
        });

      return {
        radar_id: selectedRadarId || null,
        status: statusFilter === "all" ? undefined : [statusFilter],
        include_weak: includeWeak, unread_only:unread,
        filters: dynamicFilters,
        search: search.trim() || null,
        sort: { by: sortBy, dir: sortDir },
        limit: 25,
        cursor: pageCursor,
      };
    },
    [selectedRadarId, statusFilter, filterRows, radarFields, search, sortBy, sortDir,includeWeak,unread]
  );

  const loadTable = useCallback(async () => {
    const request=++seq.current;setLoading(true);setError(null);
    try {
      const res=await api.leadList(buildFilterQuery(cursor));
      if(request!==seq.current)return;
      setLeads(res.items);setTotal(res.total);setNextCursor(res.next_cursor);setSelectedRows([]);
    } catch(e){if(request===seq.current)setError(String(e));} finally {if(request===seq.current)setLoading(false);}
  }, [buildFilterQuery,cursor]);

  useEffect(() => {
    void loadTable();
    return()=>{seq.current++;};
  }, [loadTable, refreshToken]);
  useEffect(()=>{setCursor(null);setPageHistory([]);},[selectedRadarId,statusFilter,filterRows,search,includeWeak,unread]);

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
    <div className="lead-table-workspace">
      <div className="screen-header">
        <div>
          <h1 className="screen-title">Cơ hội: Bảng tin</h1>
          <p className="screen-subtitle">
            Cột tự động hiển thị theo các trường của Radar đang chọn. Lọc sâu và xuất CSV / XLSX
          </p>
        </div>

        <div className="screen-actions export-actions">
          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12.5 }}>
            <input
              type="checkbox"
              checked={includePostText}
              onChange={(e) => setIncludePostText(e.target.checked)}
            />
            <span>Kèm nội dung bài gốc</span>
          </label>
          <button type="button" className="btn" onClick={() => void handleExport("csv").catch(e=>setError(String(e)))}>
            Xuất CSV
          </button>
          <button
            type="button"
            className="btn btn-primary"
            title={
              license.limits.allow_xlsx_export
                ? "Xuất Excel XLSX"
                : "Xuất XLSX (Gói Chuyên nghiệp)"
            }
            disabled={!license.limits.allow_xlsx_export}
            onClick={() => void handleExport("xlsx").catch(e=>setError(String(e)))}
          >
            Xuất XLSX
          </button>
        </div>
      </div>

      {error&&<div className="health-banner danger" role="alert">{error}<button className="btn" onClick={()=>void loadTable()}>Thử lại</button></div>}
      <div className="toolbar-row table-options"><label><input type="checkbox" checked={includeWeak} onChange={e=>setIncludeWeak(e.target.checked)}/> Bao gồm cơ hội cần xem thêm</label><label><input type="checkbox" checked={unread} onChange={e=>setUnread(e.target.checked)}/> Chỉ chưa đọc</label><details><summary>Cột hiển thị</summary>{radarFields.map(f=><label key={f.key}><input type="checkbox" checked={!hiddenColumns.includes(f.key)} onChange={e=>setHiddenColumns(xs=>e.target.checked?xs.filter(k=>k!==f.key):[...xs,f.key])}/>{f.label}</label>)}</details><button className="btn btn-sm" onClick={()=>{setSearch("");setStatusFilter("all");setFilterRows([]);setUnread(false);}}>Xoá bộ lọc</button></div>
      {selectedRows.length>0&&<div className="bulk-actions"><strong>Đã chọn {selectedRows.length} cơ hội</strong><button className="btn" disabled={loading} onClick={()=>{setLoading(true);void Promise.all(selectedRows.map(id=>api.leadSetStatus(id,"contacted"))).then(()=>{onLeadChanged();return loadTable();}).catch(e=>setError(String(e))).finally(()=>setLoading(false));}}>Đánh dấu đã liên hệ</button><button className="btn" onClick={()=>setSelectedRows([])}>Bỏ chọn</button></div>}
      {exportMsg && (
        <div className="health-banner info" style={{ borderRadius: 6, marginBottom: 12 }}>
          <span>{exportMsg}</span>
        </div>
      )}

      {/* Primary Toolbar */}
      <div className="toolbar-row table-filters">
        <select
          aria-label="Chọn Radar cho Bảng tin"
          className="select"
          
          value={selectedRadarId}
          onChange={(e) => setSelectedRadarId(e.target.value)}
        >
          <option value="">Tất cả radar</option>
          {radars.map((r) => (
            <option key={r.id} value={r.id}>
              Radar: {r.name}
            </option>
          ))}
        </select>

        <select
          aria-label="Trạng thái bảng tin"
          className="select"
          
          value={statusFilter}
          onChange={(e) => {
            setCursor(null);
            setStatusFilter(e.target.value as LeadStatus | "all");
          }}
        >
          <option value="all">Mọi trạng thái</option>
          {(Object.keys(LEAD_STATUS_LABELS) as LeadStatus[]).filter(st=>st!=="viewed").map((st) => (
            <option key={st} value={st}>
              {LEAD_STATUS_LABELS[st]}
            </option>
          ))}
        </select>

        <input
          type="search"
          aria-label="Tìm toàn văn trên Bảng tin"
          className="input"
          
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
      <div className="table-wrap lead-table-scroll" aria-busy={loading}>
        <table className="crm-table" data-testid="dynamic-lead-table">
          <thead>
            <tr>
              <th>Chọn</th>
              <th tabIndex={0} onKeyDown={e=>{if(e.key==="Enter")toggleSort("created_at");}} className="sortable" onClick={() => toggleSort("created_at")}>
                Thời gian {sortBy === "created_at" ? (sortDir === "asc" ? "↑" : "↓") : ""}
              </th>
              <th tabIndex={0} onKeyDown={e=>{if(e.key==="Enter")toggleSort("score");}} className="sortable" onClick={() => toggleSort("score")}>
                Điểm {sortBy === "score" ? (sortDir === "asc" ? "↑" : "↓") : ""}
              </th>
              <th>Trạng thái</th>
              {radarFields.filter(f=>!hiddenColumns.includes(f.key)).map((fd) => (
                <th
                  key={fd.key}
                  tabIndex={0}
                  onKeyDown={e=>{if(e.key==="Enter")toggleSort(fd.key);}}
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
                tabIndex={0}
                onKeyDown={e=>{if(e.key==="Enter")setActiveLeadId(lead.id);}}
                onClick={() => setActiveLeadId(lead.id)}
              >
                <td onClick={e=>e.stopPropagation()}><input type="checkbox" aria-label={`Chọn ${lead.summary}`} checked={selectedRows.includes(lead.id)} onChange={e=>setSelectedRows(xs=>e.target.checked?[...xs,lead.id]:xs.filter(id=>id!==lead.id))}/></td>
                <td style={{ whiteSpace: "nowrap" }}>{formatExactTime(lead.post_created_at)}</td>
                <td>
                  <span className={`badge ${lead.is_weak_match ? "badge-warning" : "badge-success"}`}>
                    {(lead.score * 100).toFixed(0)}%
                  </span>
                </td>
                <td>
                  <span className="badge">{LEAD_STATUS_LABELS[lead.status]}</span>
                </td>
                {radarFields.filter(f=>!hiddenColumns.includes(f.key)).map((fd) => (
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
      <div className="pagination table-pagination">
        <button
          type="button"
          className="btn btn-sm"
          disabled={!pageHistory.length}
          onClick={() => {setCursor(pageHistory[pageHistory.length-1]??null);setPageHistory(xs=>xs.slice(0,-1));}}
        >
          Trang trước
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={!nextCursor}
          onClick={() => {setPageHistory(xs=>[...xs,cursor]);setCursor(nextCursor);}}
        >
          Trang tiếp theo
        </button>
      </div>

      {/* Slide-over Lead Detail Modal */}
      {activeLeadId && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Chi tiết tin từ Bảng tin">
          <div className="modal-panel" style={{ maxWidth: 820 }}>
            <div className="modal-body">
              <LeadDetailPanel
                key={activeLeadId}
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
