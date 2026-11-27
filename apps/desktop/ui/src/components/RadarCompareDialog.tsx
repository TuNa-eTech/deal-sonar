// "So sánh biến thể": run two radar definitions over the same posts and show what changed.

import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type {
  CompareChange,
  CompareItem,
  ExtractedField,
  Radar,
  RadarComparison,
  RadarDetail,
  Source,
} from "../types/ipc";
import {
  Badge,
  Button,
  Field,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Select,
} from "./ui";

interface Props {
  radars: Radar[];
  initialLeftId?: string;
  onClose: () => void;
}

const SECTIONS: Array<{ change: CompareChange; title: string; open: boolean }> = [
  { change: "newly_matched", title: "Bài mới khớp ở B", open: true },
  { change: "no_longer_matched", title: "Bài hết khớp ở B", open: true },
  { change: "fields_changed", title: "Vẫn khớp nhưng đổi trường trích", open: true },
  { change: "not_compared", title: "Chưa so sánh được", open: true },
  { change: "still_matched", title: "Vẫn khớp, không đổi", open: false },
  { change: "still_unmatched", title: "Không khớp ở cả hai", open: false },
];

function showField(f: ExtractedField | null): string {
  if (!f) return "(không có)";
  return f.raw?.trim() ? f.raw : JSON.stringify(f.value);
}

function percent(score: number | null): string {
  return score == null ? "—" : `${Math.round(score * 100)}%`;
}

function SidePicker(props: {
  name: "A" | "B";
  radars: Radar[];
  radarId: string;
  version: number | null;
  detail: RadarDetail | null;
  onRadar: (id: string) => void;
  onVersion: (v: number) => void;
}) {
  const { name, radars, radarId, version, detail, onRadar, onVersion } = props;
  return (
    <div>
      <Field label={`Radar ${name}`} htmlFor={`compare-radar-${name}`}>
        <Select
          id={`compare-radar-${name}`}
          value={radarId}
          onChange={(e) => onRadar(e.target.value)}
        >
          {radars.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={`Phiên bản ${name}`} htmlFor={`compare-version-${name}`}>
        <Select
          id={`compare-version-${name}`}
          value={version ?? ""}
          disabled={!detail}
          onChange={(e) => onVersion(Number(e.target.value))}
        >
          {(detail?.versions ?? []).map((v) => (
            <option key={v.id} value={v.version}>
              v{v.version}
              {v.version === detail?.radar.current_version ? " (đang dùng)" : ""}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

function ItemCard({ item }: { item: CompareItem }) {
  return (
    <li className="card" style={{ padding: 12, marginBottom: 8, listStyle: "none" }}>
      <p style={{ margin: "0 0 6px" }}>
        <strong>{item.author_name || "Bài đã quét"}</strong>
        {item.source_name ? ` · ${item.source_name}` : ""}
      </p>
      {item.post_text && (
        <blockquote style={{ margin: "0 0 8px" }}>
          {item.post_text.length > 220 ? `${item.post_text.slice(0, 220)}…` : item.post_text}
        </blockquote>
      )}
      <p style={{ margin: "0 0 6px" }}>{item.reason}</p>
      <div className="toolbar-row">
        <Badge tone={item.left.verdict === "match" ? "success" : undefined}>
          A: {item.left.verdict === "match" ? "khớp" : "không khớp"} {percent(item.left.score)}
        </Badge>
        <Badge tone={item.right.verdict === "match" ? "success" : undefined}>
          B: {item.right.verdict === "match" ? "khớp" : "không khớp"} {percent(item.right.score)}
        </Badge>
      </div>
      {item.field_changes.length > 0 && (
        <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
          {item.field_changes.map((c) => (
            <li key={c.key}>
              {c.label}: «{showField(c.before)}» → «{showField(c.after)}»
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export const RadarCompareDialog: React.FC<Props> = ({ radars, initialLeftId, onClose }) => {
  const [leftId, setLeftId] = useState(initialLeftId ?? radars[0]?.id ?? "");
  const [rightId, setRightId] = useState(
    radars.find((r) => r.variant_of === (initialLeftId ?? radars[0]?.id))?.id ??
      radars.find((r) => r.id !== (initialLeftId ?? radars[0]?.id))?.id ??
      radars[0]?.id ??
      ""
  );
  const [leftDetail, setLeftDetail] = useState<RadarDetail | null>(null);
  const [rightDetail, setRightDetail] = useState<RadarDetail | null>(null);
  const [leftVersion, setLeftVersion] = useState<number | null>(null);
  const [rightVersion, setRightVersion] = useState<number | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RadarComparison | null>(null);

  useEffect(() => {
    void api.sourceList().then(setSources).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!leftId) return;
    void api.radarGet(leftId).then((d) => {
      if (cancelled) return;
      setLeftDetail(d);
      setLeftVersion(d.radar.current_version);
    });
    return () => {
      cancelled = true;
    };
  }, [leftId]);

  useEffect(() => {
    let cancelled = false;
    if (!rightId) return;
    void api.radarGet(rightId).then((d) => {
      if (cancelled) return;
      setRightDetail(d);
      setRightVersion(d.radar.current_version);
    });
    return () => {
      cancelled = true;
    };
  }, [rightId]);

  // Start from the groups both radars already follow.
  useEffect(() => {
    if (!leftDetail || !rightDetail) return;
    setSourceIds(leftDetail.radar.source_ids.filter((id) => rightDetail.radar.source_ids.includes(id)));
  }, [leftDetail, rightDetail]);

  const sourceName = useMemo(() => new Map(sources.map((s) => [s.id, s.name])), [sources]);
  const candidateSources = useMemo(() => {
    const union = new Set([...(leftDetail?.radar.source_ids ?? []), ...(rightDetail?.radar.source_ids ?? [])]);
    return sources.filter((s) => union.has(s.id));
  }, [sources, leftDetail, rightDetail]);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await api.radarCompareRun({
          left: { radar_id: leftId, version: leftVersion },
          right: { radar_id: rightId, version: rightVersion },
          source_ids: sourceIds,
        })
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const diff = result?.definition_diff;
  const diffNotes = diff
    ? [
        diff.same_version && "Hai bên là cùng một phiên bản.",
        diff.description_changed && "mô tả",
        diff.want_intent_changed && "chiều cần tìm",
        diff.exclude_roles_changed && "cách loại người cùng nghề",
        diff.hard_filters_changed && "điều kiện lọc cứng",
        diff.fields_only_left.length + diff.fields_only_right.length + diff.fields_changed.length > 0 &&
          "trường trích",
      ].filter(Boolean)
    : [];

  return (
    <Modal label="So sánh biến thể Radar" size="lg">
      <ModalHeader>
        <h2>So sánh hai định nghĩa Radar</h2>
      </ModalHeader>
      <ModalBody>
        <p className="field-hint">
          Chấm cùng một tập bài bằng hai định nghĩa. Đây chỉ là xem thử: không tạo cơ hội thật, không
          gửi thông báo và không đổi Radar nào.
        </p>
        <div className="toolbar-row">
          <SidePicker
            name="A"
            radars={radars}
            radarId={leftId}
            version={leftVersion}
            detail={leftDetail}
            onRadar={setLeftId}
            onVersion={setLeftVersion}
          />
          <SidePicker
            name="B"
            radars={radars}
            radarId={rightId}
            version={rightVersion}
            detail={rightDetail}
            onRadar={setRightId}
            onVersion={setRightVersion}
          />
        </div>

        <fieldset>
          <legend>Tập bài chung: bài gần nhất của các group · đã chọn {sourceIds.length}</legend>
          {candidateSources.length === 0 && <p className="field-hint">Hai radar chưa chọn group nào.</p>}
          {candidateSources.map((s) => (
            <label key={s.id} style={{ display: "block" }}>
              <input
                type="checkbox"
                aria-label={`Group ${s.name}`}
                checked={sourceIds.includes(s.id)}
                onChange={(e) =>
                  setSourceIds((prev) => (e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id)))
                }
              />{" "}
              {s.name}
            </label>
          ))}
        </fieldset>

        {error && <p role="alert">{error}</p>}

        {result && (
          <section aria-label="Kết quả so sánh">
            <h3>Kết quả</h3>
            <p>
              A: {result.left.radar_name} v{result.left.version} · B: {result.right.radar_name} v
              {result.right.version} · {result.post_ids.length} bài
              {result.source_ids.length > 0
                ? ` từ ${result.source_ids.map((id) => sourceName.get(id) ?? id).join(", ")}`
                : ""}
              .
            </p>
            {diffNotes.length > 0 && (
              <p className="field-hint">
                {diff?.same_version
                  ? diffNotes[0]
                  : `Hai định nghĩa khác nhau ở: ${diffNotes.join(", ")}.`}
              </p>
            )}
            <div className="toolbar-row">
              <Badge tone="success">Mới khớp {result.counts.newly_matched}</Badge>
              <Badge tone="warning">Hết khớp {result.counts.no_longer_matched}</Badge>
              <Badge>Đổi trường {result.counts.fields_changed}</Badge>
              <Badge>Vẫn khớp {result.counts.still_matched}</Badge>
              <Badge>Không khớp {result.counts.still_unmatched}</Badge>
              {result.counts.not_compared > 0 && <Badge>Chưa so sánh {result.counts.not_compared}</Badge>}
            </div>
            {SECTIONS.map(({ change, title, open }) => {
              const items = result.items.filter((i) => i.change === change);
              if (items.length === 0) return null;
              return (
                <details key={change} open={open}>
                  <summary>
                    {title} ({items.length})
                  </summary>
                  <ul style={{ padding: 0 }}>
                    {items.map((item) => (
                      <ItemCard key={item.post_id} item={item} />
                    ))}
                  </ul>
                </details>
              );
            })}
          </section>
        )}
      </ModalBody>
      <ModalFooter>
        <Button onClick={onClose}>Đóng</Button>
        <Button
          variant="primary"
          disabled={busy || !leftId || !rightId || sourceIds.length === 0}
          onClick={() => void run()}
        >
          {busy ? "Đang so sánh…" : "So sánh"}
        </Button>
      </ModalFooter>
    </Modal>
  );
};
