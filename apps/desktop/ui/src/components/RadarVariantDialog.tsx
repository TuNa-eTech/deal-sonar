// "Tạo biến thể": review and edit a copy of a radar before saving it as an independent draft.

import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { lifetimeOptions } from "../lib/format";
import type {
  Channel,
  LicenseStatus,
  RadarDetail,
  RadarNotifyConfig,
  RadarVariantDraft,
  Source,
} from "../types/ipc";
import {
  Badge,
  Button,
  Field,
  Input,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Select,
  Textarea,
} from "./ui";

interface Props {
  sourceRadarId: string;
  license: LicenseStatus;
  onClose: () => void;
  onCreated: (detail: RadarDetail) => void;
}

const INTENT_LABELS = { demand: "Người cần", supply: "Người có", any: "Cả hai phía" } as const;

type ChannelScope = "local" | "default" | "selected";

function channelScopeOf(notify: RadarNotifyConfig): ChannelScope {
  if (notify.inherit_channels ?? notify.channel_ids.length === 0) return "default";
  return notify.channel_ids.length ? "selected" : "local";
}

export const RadarVariantDialog: React.FC<Props> = ({
  sourceRadarId,
  license,
  onClose,
  onCreated,
}) => {
  const [draft, setDraft] = useState<RadarVariantDraft | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [notify, setNotify] = useState<RadarNotifyConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api.radarVariantPrepare(sourceRadarId),
      api.sourceList(),
      api.channelList(),
    ])
      .then(([proposal, sourceList, channelList]) => {
        if (cancelled) return;
        setDraft(proposal);
        setSources(sourceList);
        setChannels(channelList);
        setName(proposal.input.name);
        setDescription(proposal.input.description);
        setSourceIds(proposal.input.source_ids);
        setNotify({
          channel_ids: [],
          mode: "instant",
          min_score: 0.6,
          quiet_hours: null,
          ...proposal.input.notify,
        });
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [sourceRadarId]);

  const maxGroups = license.limits.max_followed_groups;
  const followedIds = useMemo(
    () => new Set(sources.filter((s) => s.followed).map((s) => s.id)),
    [sources]
  );
  const activeChannels = channels.filter((c) => c.state === "ok");

  const toggleSource = (id: string) => {
    setError(null);
    setSourceIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (new Set([...followedIds, ...prev, id]).size > maxGroups) {
        setError(`Gói hiện tại giới hạn tối đa ${maxGroups} group theo dõi.`);
        return prev;
      }
      return [...prev, id];
    });
  };

  const save = async () => {
    if (!draft || !notify) return;
    if (!name.trim()) return setError("Hãy đặt tên cho biến thể.");
    if (!description.trim()) return setError("Mô tả không được để trống.");
    setBusy(true);
    setError(null);
    try {
      const detail = await api.radarCreateVariant({
        source_radar_id: draft.source_radar_id,
        input: {
          ...draft.input,
          name: name.trim(),
          description: description.trim(),
          source_ids: sourceIds,
          notify,
        },
      });
      onCreated(detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const policy = draft?.input.match_policy;
  const scope = notify ? channelScopeOf(notify) : "default";

  return (
    <Modal label="Tạo biến thể Radar" size="lg">
      <ModalHeader>
        <h2>Tạo biến thể{draft ? ` từ “${draft.source_radar_name}”` : ""}</h2>
      </ModalHeader>
      <ModalBody>
        {!draft || !notify ? (
          error ? <p role="alert">{error}</p> : <p>Đang chuẩn bị bản sao…</p>
        ) : (
          <>
            <p className="field-hint">
              Biến thể là một Radar độc lập, lưu ở trạng thái bản nháp và chưa gửi thông báo cho tới
              khi bạn xem thử và bật. Tin cũ, lịch sử chấm và nhãn phản hồi vẫn thuộc Radar gốc;
              chỉnh sửa hay lưu trữ biến thể không ảnh hưởng Radar gốc.
            </p>

            <Field label="Tên biến thể" htmlFor="variant-name">
              <Input id="variant-name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Mô tả nhu cầu" htmlFor="variant-description">
              <Textarea
                id="variant-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>

            <fieldset>
              <legend>
                Nhóm nguồn · đã chọn {sourceIds.length} (theo dõi tối đa {maxGroups})
              </legend>
              {sources.length === 0 && <p className="field-hint">Chưa có group nào.</p>}
              {sources.map((s) => (
                <label key={s.id} style={{ display: "block" }}>
                  <input
                    type="checkbox"
                    aria-label={`Nguồn ${s.name}`}
                    checked={sourceIds.includes(s.id)}
                    onChange={() => toggleSource(s.id)}
                  />{" "}
                  {s.name}
                </label>
              ))}
            </fieldset>

            <fieldset>
              <legend>Kênh nhận tin</legend>
              <Select
                aria-label="Phạm vi nhận thông báo của biến thể"
                value={scope}
                onChange={(e) => {
                  const next = e.target.value as ChannelScope;
                  setNotify({
                    ...notify,
                    inherit_channels: next === "default",
                    channel_ids: next === "selected" ? activeChannels.map((c) => c.id) : [],
                  });
                }}
              >
                <option value="local">Chỉ nhận trên máy này</option>
                <option value="default">Dùng tất cả kênh mặc định</option>
                <option value="selected" disabled={!activeChannels.length}>
                  Chọn kênh cho biến thể này
                </option>
              </Select>
              {scope === "selected" &&
                channels.map((c) => (
                  <label key={c.id} style={{ display: "block" }}>
                    <input
                      type="checkbox"
                      aria-label={`Kênh ${c.name}`}
                      checked={notify.channel_ids.includes(c.id)}
                      onChange={(e) =>
                        setNotify({
                          ...notify,
                          inherit_channels: false,
                          channel_ids: e.target.checked
                            ? [...notify.channel_ids, c.id]
                            : notify.channel_ids.filter((id) => id !== c.id),
                        })
                      }
                    />{" "}
                    {c.name} {c.state !== "ok" ? "(cần kết nối lại)" : ""}
                  </label>
                ))}
            </fieldset>

            <div className="toolbar-row">
              <Field label="Chế độ thông báo" htmlFor="variant-mode">
                <Select
                  id="variant-mode"
                  value={notify.mode}
                  onChange={(e) =>
                    setNotify({ ...notify, mode: e.target.value as "instant" | "digest" })
                  }
                >
                  <option value="instant">Báo ngay</option>
                  <option value="digest">Gửi gộp</option>
                </Select>
              </Field>
              <Field label="Tin còn giá trị trong" htmlFor="variant-ttl">
                <Select
                  id="variant-ttl"
                  value={notify.lead_ttl_hours ?? ""}
                  onChange={(e) =>
                    setNotify({
                      ...notify,
                      lead_ttl_hours: e.target.value ? Number(e.target.value) : null,
                    })
                  }
                >
                  {lifetimeOptions(notify.lead_ttl_hours).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Điểm tối thiểu để báo" htmlFor="variant-min-score">
                <Input
                  id="variant-min-score"
                  type="number"
                  min={0.4}
                  max={1}
                  step={0.05}
                  value={notify.min_score}
                  onChange={(e) => setNotify({ ...notify, min_score: Number(e.target.value) })}
                />
              </Field>
            </div>

            <section aria-label="Phần sao chép giữ nguyên">
              <strong>Sao chép nguyên từ Radar gốc</strong>
              <p className="field-hint">
                Sửa các phần này sau khi lưu, trong trình sửa Radar của biến thể.
              </p>
              <p>
                Trường trích xuất ({draft.input.fields.length}):{" "}
                {draft.input.fields.map((f) => (
                  <Badge key={f.key} style={{ marginRight: 4 }}>
                    {f.label}
                  </Badge>
                ))}
              </p>
              {policy && (
                <p>
                  Ý định: {INTENT_LABELS[policy.want_intent]} · loại người cùng nghề:{" "}
                  {policy.exclude_roles.includes("peer") ? "có" : "không"} · điều kiện bắt buộc:{" "}
                  {policy.hard_filters.length}
                </p>
              )}
            </section>

            {error && <p role="alert">{error}</p>}
          </>
        )}
      </ModalBody>
      <ModalFooter>
        <Button onClick={onClose} disabled={busy}>
          Huỷ
        </Button>
        <Button variant="primary" onClick={() => void save()} disabled={busy || !draft}>
          Lưu biến thể (bản nháp)
        </Button>
      </ModalFooter>
    </Modal>
  );
};
