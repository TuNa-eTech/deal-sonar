import React, { useEffect, useMemo, useState } from "react";
import { api, onDesktopEvent } from "../lib/api";
import {
  composeTemplateDescription,
  FIELD_TYPE_LABELS,
  formatExtractedFieldValue,
  slugifyFieldKey,
} from "../lib/format";
import { openSafeSetupUrl, renderHighlightedPostText } from "../lib/security";
import type {
  FieldDef,
  FieldType,
  LicenseStatus,
  MatchPolicy,
  PreviewItem,
  PreviewRunState,
  RadarDetail,
  RadarTemplate,
  Source,
  WantIntent,
} from "../types/ipc";

const BLANK_EXAMPLES = [
  {
    title: "BĐS — Khách thuê chung cư",
    description:
      "Người đang cần thuê căn hộ 2 phòng ngủ ở Cầu Giấy hoặc Mỹ Đình, ngân sách dưới 15 triệu/tháng",
    profession: "môi giới bất động sản",
    intent: "demand" as WantIntent,
  },
  {
    title: "Dịch vụ — Tìm thợ điện lạnh",
    description:
      "Chủ nhà hỏi tìm thợ sửa điều hoà, vệ sinh máy giặt hoặc sửa điện nước gấp tại nội thành Hà Nội",
    profession: "thợ sửa chữa điện nước điều hoà",
    intent: "demand" as WantIntent,
  },
  {
    title: "Xe & đồ cũ — Người dùng bán gấp",
    description:
      "Cá nhân chính chủ cần bán gấp xe ô tô Toyota Vios hoặc Hyundai Accent đời từ 2019 trở lên tại miền Bắc",
    profession: "người thu mua ô tô cũ",
    intent: "supply" as WantIntent,
  },
];

interface RadarWizardProps {
  templates: RadarTemplate[];
  sources: Source[];
  license: LicenseStatus;
  initialTemplate?: RadarTemplate | null;
  editRadar?: RadarDetail | null;
  initialStep?: 1 | 2 | 3 | 4;
  onClose: () => void;
  onSaved: (radarId: string) => void;
}

export const RadarWizard: React.FC<RadarWizardProps> = ({
  templates,
  sources: initialSources,
  license,
  initialTemplate = null,
  editRadar = null,
  initialStep = 1,
  onClose,
  onSaved,
}) => {
  const isEditingActive = editRadar?.radar.status === "active";

  const [step, setStep] = useState<1 | 2 | 3 | 4>(initialStep);
  const [mode, setMode] = useState<"template" | "blank">(
    editRadar
      ? editRadar.radar.template_id
        ? "template"
        : "blank"
      : initialTemplate
        ? "template"
        : "template"
  );

  const defaultTpl =
    initialTemplate ??
    (editRadar?.radar.template_id
      ? templates.find((t) => t.id === editRadar.radar.template_id) ?? templates[0] ?? null
      : templates[0] ?? null);

  const [selectedTemplate, setSelectedTemplate] = useState<RadarTemplate | null>(
    mode === "template" ? defaultTpl : null
  );
  const [placeholderValues, setPlaceholderValues] = useState<Record<string, string>>({});

  const [radarName, setRadarName] = useState<string>(
    editRadar?.radar.name ?? defaultTpl?.name ?? ""
  );
  const [description, setDescription] = useState<string>(
    editRadar?.current_version_data.description ??
      (defaultTpl ? composeTemplateDescription(defaultTpl, {}) : "")
  );
  const [userProfession, setUserProfession] = useState<string>(
    editRadar?.current_version_data.user_profession ?? defaultTpl?.user_profession ?? ""
  );
  const [wantIntent, setWantIntent] = useState<WantIntent>(
    editRadar?.current_version_data.match_policy.want_intent ??
      defaultTpl?.match_policy.want_intent ??
      "demand"
  );
  const [excludePeers, setExcludePeers] = useState<boolean>(
    editRadar
      ? editRadar.current_version_data.match_policy.exclude_roles.includes("peer")
      : (defaultTpl?.match_policy.exclude_roles.includes("peer") ?? true)
  );

  const [fields, setFields] = useState<FieldDef[]>(
    structuredClone(
      editRadar?.current_version_data.fields ?? defaultTpl?.fields ?? []
    )
  );
  const [suggesting, setSuggesting] = useState(false);
  const [clarifyingQuestions, setClarifyingQuestions] = useState<string[]>([]);
  const [clarifyingDismissed, setClarifyingDismissed] = useState(false);

  const [sources, setSources] = useState<Source[]>(initialSources);
  const [sourceQuery, setSourceQuery] = useState("");
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>(
    editRadar?.radar.source_ids ??
      initialSources.filter((s) => s.followed).map((s) => s.id)
  );

  const [draftRadarId, setDraftRadarId] = useState<string | null>(
    editRadar?.radar.id ?? null
  );
  const [requiresVersionConfirm, setRequiresVersionConfirm] = useState(false);
  const [confirmedUpgrade, setConfirmedUpgrade] = useState(false);
  const [previewState, setPreviewState] = useState<PreviewRunState | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const maxFields = license.limits.max_fields_per_radar;
  const maxGroups = license.limits.max_followed_groups;

  const selectTemplate = (tpl: RadarTemplate) => {
    setMode("template");
    setSelectedTemplate(tpl);
    setPlaceholderValues({});
    setRadarName(tpl.name);
    setDescription(composeTemplateDescription(tpl, {}));
    setUserProfession(tpl.user_profession);
    setWantIntent(tpl.match_policy.want_intent);
    setExcludePeers(tpl.match_policy.exclude_roles.includes("peer"));
    setFields(structuredClone(tpl.fields).slice(0, maxFields));
  };

  const handlePlaceholderChange = (key: string, val: string) => {
    const next = { ...placeholderValues, [key]: val };
    setPlaceholderValues(next);
    if (selectedTemplate) {
      setDescription(composeTemplateDescription(selectedTemplate, next));
      const areaHint = next["khu vực"] || next["tuyến đường"] || next["dòng hàng"] || next["vị trí"];
      if (areaHint && areaHint.trim()) {
        setRadarName(`${selectedTemplate.name} — ${areaHint.trim()}`.slice(0, 60));
      }
    }
  };

  const runSuggestFields = async (forceReplace: boolean) => {
    setSuggesting(true);
    setErrorMsg(null);
    try {
      const res = await api.radarSuggestFields({
        description,
        user_profession: userProfession || null,
        template_id: mode === "template" ? selectedTemplate?.id ?? null : null,
        language_hint: "vi",
      });
      if (forceReplace || fields.length === 0) {
        setFields(res.fields.slice(0, maxFields));
      }
      if (!radarName.trim()) {
        setRadarName(res.suggested_name);
      }
      setClarifyingQuestions(res.clarifying_questions ?? []);
      setClarifyingDismissed(false);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSuggesting(false);
    }
  };

  const goToStep2 = async () => {
    if (!description.trim()) {
      setErrorMsg("Vui lòng nhập mô tả thứ bạn cần tìm trước khi tiếp tục.");
      return;
    }
    setErrorMsg(null);
    setStep(2);
    if (mode === "blank" && fields.length === 0) {
      await runSuggestFields(true);
    }
  };

  const goToStep3 = () => {
    if (fields.length === 0) {
      setErrorMsg("Cần ít nhất 1 trường dữ liệu để trích xuất.");
      return;
    }
    setErrorMsg(null);
    setStep(3);
  };

  // Subscribe to streaming `preview:progress` events!
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void onDesktopEvent("preview:progress", (ev) => {
      setPreviewState((prev) => {
        if (!prev || prev.preview_id !== ev.preview_id) return prev;
        const existingIds = new Set(prev.items.map((i) => i.evaluation_id));
        const mergedItems = [
          ...prev.items,
          ...ev.new_items.filter((i) => !existingIds.has(i.evaluation_id)),
        ];
        return {
          ...prev,
          status: ev.status,
          evaluated_posts: ev.evaluated_posts,
          total_posts: ev.total_posts,
          items: mergedItems,
          warnings: ev.warnings,
        };
      });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const currentMatchPolicy = (): MatchPolicy => ({
    want_intent: wantIntent,
    exclude_roles: excludePeers ? ["peer"] : [],
    hard_filters: editRadar?.current_version_data.match_policy.hard_filters ?? [],
  });

  const startPreviewRun = async (overrideFields?: FieldDef[]) => {
    setPreviewLoading(true);
    setErrorMsg(null);
    const activeFields = (overrideFields ?? fields).map((f, idx) => ({
      ...f,
      order: idx + 1,
    }));

    try {
      let rId = draftRadarId;
      if (!rId) {
        const created = await api.radarCreateDraft({
          name: radarName.trim() || "Radar mới",
          template_id: mode === "template" ? selectedTemplate?.id ?? null : null,
          description,
          user_profession: userProfession.trim() || null,
          fields: activeFields,
          match_policy: currentMatchPolicy(),
          source_ids: selectedSourceIds,
        });
        rId = created.radar.id;
        setDraftRadarId(rId);
      } else {
        const upd = await api.radarUpdate({
          id: rId,
          name: radarName.trim() || "Radar mới",
          description,
          user_profession: userProfession.trim() || null,
          fields: activeFields,
          match_policy: currentMatchPolicy(),
          source_ids: selectedSourceIds,
          confirm_version_upgrade: false,
        });
        setRequiresVersionConfirm(upd.requires_confirmation);
      }

      const started = await api.radarPreviewStart({
        radar_id: rId,
        description,
        user_profession: userProfession.trim() || null,
        fields: activeFields,
        match_policy: currentMatchPolicy(),
        source_ids: selectedSourceIds,
      });
      setPreviewState(started);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewLoading(false);
    }
  };

  useEffect(() => {
    if (initialStep === 4 && editRadar) {
      void startPreviewRun();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goToStep4 = async () => {
    if (selectedSourceIds.length === 0) {
      setErrorMsg("Hãy chọn ít nhất 1 group nguồn để chạy xem thử.");
      return;
    }
    setErrorMsg(null);
    setStep(4);
    await startPreviewRun();
  };

  const updateField = (idx: number, patch: Partial<FieldDef>) => {
    setFields((prev) =>
      prev.map((f, i) => {
        if (i !== idx) return f;
        const merged = { ...f, ...patch };
        if (
          (merged.type === "enum" || merged.type === "multi_enum") &&
          (!merged.options || merged.options.length === 0)
        ) {
          merged.options = ["lựa chọn 1", "lựa chọn 2"];
        }
        if (merged.type !== "enum" && merged.type !== "multi_enum") {
          merged.options = null;
        }
        return merged;
      })
    );
  };

  const moveField = (idx: number, delta: -1 | 1) => {
    setFields((prev) => {
      const target = idx + delta;
      if (target < 0 || target >= prev.length) return prev;
      const copy = [...prev];
      const [item] = copy.splice(idx, 1);
      if (item) copy.splice(target, 0, item);
      return copy.map((f, i) => ({ ...f, order: i + 1 }));
    });
  };

  const addField = () => {
    if (fields.length >= maxFields) return;
    const nextIdx = fields.length + 1;
    setFields((prev) => [
      ...prev,
      {
        key: `custom_field_${nextIdx}`,
        label: `Trường mới ${nextIdx}`,
        type: "text",
        description: "Thông tin cần trích xuất từ bài viết",
        required: false,
        options: null,
        show_in_alert: true,
        order: nextIdx,
      },
    ]);
  };

  const removeField = (idx: number) => {
    setFields((prev) => prev.filter((_, i) => i !== idx).map((f, i) => ({ ...f, order: i + 1 })));
  };

  const toggleSource = (id: string) => {
    setSelectedSourceIds((prev) => {
      if (prev.includes(id)) {
        return prev.filter((x) => x !== id);
      }
      const alreadyFollowedIds = new Set(
        sources.filter((s) => s.followed).map((s) => s.id)
      );
      const unionSize = new Set([...alreadyFollowedIds, ...prev, id]).size;
      if (unionSize > maxGroups) {
        setErrorMsg(`Gói hiện tại giới hạn tối đa ${maxGroups} group theo dõi.`);
        return prev;
      }
      setErrorMsg(null);
      return [...prev, id];
    });
  };

  const handlePreviewFeedback = async (
    item: PreviewItem,
    label: "correct" | "irrelevant"
  ) => {
    await api.leadFeedback({
      evaluation_id: item.evaluation_id,
      post_id: item.post_id,
      label,
      origin: "preview",
    });
    setPreviewState((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.map((it) =>
              it.evaluation_id === item.evaluation_id
                ? { ...it, feedback_label: label }
                : it
            ),
          }
        : prev
    );
  };

  const handleSaveRadar = async (activate: boolean) => {
    if (isEditingActive && requiresVersionConfirm && activate && !confirmedUpgrade) {
      setErrorMsg(
        "Vui lòng đánh dấu xác nhận nâng cấp phiên bản mới cho radar đang chạy trước khi áp dụng."
      );
      return;
    }

    setSaving(true);
    setErrorMsg(null);
    try {
      const normalizedFields = fields.map((f, idx) => ({
        ...f,
        key: f.key || slugifyFieldKey(f.label, idx + 1),
        order: idx + 1,
      }));
      let rId = draftRadarId;
      if (!rId) {
        const created = await api.radarCreateDraft({
          name: radarName.trim() || "Radar mới",
          template_id: mode === "template" ? selectedTemplate?.id ?? null : null,
          description,
          user_profession: userProfession.trim() || null,
          fields: normalizedFields,
          match_policy: currentMatchPolicy(),
          source_ids: selectedSourceIds,
        });
        rId = created.radar.id;
      } else {
        await api.radarUpdate({
          id: rId,
          name: radarName.trim() || "Radar mới",
          description,
          user_profession: userProfession.trim() || null,
          fields: normalizedFields,
          match_policy: currentMatchPolicy(),
          source_ids: selectedSourceIds,
          confirm_version_upgrade: activate ? true : false,
        });
      }

      if (activate) {
        await api.radarSetStatus(rId, "active");
      }
      onSaved(rId);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const filteredSources = useMemo(() => {
    const q = sourceQuery.trim().toLowerCase();
    if (!q) return sources;
    return sources.filter((s) => s.name.toLowerCase().includes(q));
  }, [sources, sourceQuery]);

  const totalSelectedFollowed = useMemo(() => {
    const followedSet = new Set(sources.filter((s) => s.followed).map((s) => s.id));
    for (const id of selectedSourceIds) followedSet.add(id);
    return followedSet.size;
  }, [sources, selectedSourceIds]);

  const matchedPreviewItems = useMemo(
    () =>
      (previewState?.items ?? [])
        .filter((i) => i.verdict === "match")
        .sort((a, b) => b.score - a.score),
    [previewState]
  );

  const unmatchedPreviewItems = useMemo(
    () =>
      (previewState?.items ?? [])
        .filter((i) => i.verdict === "no_match")
        .sort((a, b) => b.score - a.score),
    [previewState]
  );

  const renderInlineTemplateEditor = (tpl: RadarTemplate) => {
    const parts = tpl.description_template.split(/(\{[^}]+\})/g);
    return (
      <div className="placeholder-sentence">
        {parts.map((part, idx) => {
          if (part.startsWith("{") && part.endsWith("}")) {
            const key = part.slice(1, -1);
            const ph = tpl.placeholders.find((p) => p.key === key);
            return (
              <input
                key={`${key}-${idx}`}
                type="text"
                aria-label={`Điền ${key}`}
                className="placeholder-inline-input"
                placeholder={ph?.hint ?? key}
                value={placeholderValues[key] ?? ""}
                onChange={(e) => handlePlaceholderChange(key, e.target.value)}
              />
            );
          }
          return <span key={`txt-${idx}`}>{part}</span>;
        })}
      </div>
    );
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Trình tạo và sửa Radar">
      <div className="modal-panel" style={{ maxWidth: 1060 }}>
        <div className="modal-header">
          <div>
            <h2 style={{ margin: 0, fontSize: 17 }}>
              {editRadar ? `Chỉnh sửa Radar: ${editRadar.radar.name}` : "Tạo Radar mới"}
            </h2>
            <div className="field-hint">
              4 bước nhanh gọn (&lt; 5 phút): Mô tả → Trường trích xuất → Nguồn group → Xem thử & Bật
            </div>
          </div>

          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {[
              { n: 1 as const, label: "1. Mô tả" },
              { n: 2 as const, label: "2. Trường" },
              { n: 3 as const, label: "3. Nguồn" },
              { n: 4 as const, label: "4. Xem thử và bật" },
            ].map((s) => (
              <button
                key={s.n}
                type="button"
                className={`btn btn-sm ${step === s.n ? "btn-primary" : ""}`}
                onClick={() => {
                  if (s.n === 4) {
                    void goToStep4();
                  } else {
                    setStep(s.n);
                  }
                }}
              >
                {s.label}
              </button>
            ))}
            <button type="button" className="btn btn-sm" onClick={onClose}>
              Đóng ✕
            </button>
          </div>
        </div>

        <div className="modal-body">
          {errorMsg && (
            <div className="health-banner danger" style={{ borderRadius: 6, marginBottom: 12 }}>
              <span>{errorMsg}</span>
            </div>
          )}

          {/* STEP 1: MÔ TẢ */}
          {step === 1 && (
            <div>
              <div className="toolbar-row">
                <button
                  type="button"
                  className={`btn ${mode === "template" ? "btn-primary" : ""}`}
                  onClick={() => {
                    setMode("template");
                    if (!selectedTemplate && templates[0]) selectTemplate(templates[0]);
                  }}
                >
                  Chọn mẫu theo ngành ({templates.length})
                </button>
                <button
                  type="button"
                  className={`btn ${mode === "blank" ? "btn-primary" : ""}`}
                  onClick={() => {
                    setMode("blank");
                    setSelectedTemplate(null);
                  }}
                >
                  Bắt đầu từ trang trắng
                </button>
              </div>

              {mode === "template" && (
                <div style={{ marginBottom: 14 }}>
                  <div className="template-grid" style={{ marginBottom: 14 }}>
                    {templates.map((tpl) => (
                      <button
                        key={tpl.id}
                        type="button"
                        className={`template-card ${selectedTemplate?.id === tpl.id ? "selected" : ""}`}
                        onClick={() => selectTemplate(tpl)}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
                          <span className="badge badge-primary">{tpl.industry}</span>
                          {tpl.seed_ruleset && (
                            <span className="badge badge-success">Có sẵn bộ luật</span>
                          )}
                        </div>
                        <strong style={{ fontSize: 13.5 }}>{tpl.name}</strong>
                        <span className="field-hint">{tpl.description_template}</span>
                      </button>
                    ))}
                  </div>

                  {selectedTemplate && (
                    <div className="field-group">
                      <span className="field-label">
                        Điền nhanh vào câu mẫu «{selectedTemplate.name}»:
                      </span>
                      {renderInlineTemplateEditor(selectedTemplate)}
                    </div>
                  )}
                </div>
              )}

              {mode === "blank" && (
                <div style={{ marginBottom: 14 }}>
                  <div className="field-label" style={{ marginBottom: 6 }}>
                    Ba ví dụ mô tả tốt để tham khảo (bấm để chép mẫu):
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                    {BLANK_EXAMPLES.map((ex) => (
                      <button
                        key={ex.title}
                        type="button"
                        className="template-card"
                        onClick={() => {
                          setRadarName(ex.title);
                          setDescription(ex.description);
                          setUserProfession(ex.profession);
                          setWantIntent(ex.intent);
                          setFields([]);
                        }}
                      >
                        <strong>{ex.title}</strong>
                        <span className="field-hint">{ex.description}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div className="field-group">
                  <label className="field-label" htmlFor="radar-name-input">
                    Tên gọi Radar
                  </label>
                  <input
                    id="radar-name-input"
                    type="text"
                    className="input"
                    value={radarName}
                    onChange={(e) => setRadarName(e.target.value)}
                    placeholder="Ví dụ: Khách thuê căn hộ Cầu Giấy"
                  />
                </div>

                <div className="field-group">
                  <label className="field-label" htmlFor="user-profession-input">
                    Bạn làm nghề gì?
                  </label>
                  <input
                    id="user-profession-input"
                    type="text"
                    className="input"
                    value={userProfession}
                    onChange={(e) => setUserProfession(e.target.value)}
                    placeholder="Ví dụ: môi giới bất động sản, thợ điện nước…"
                  />
                  <span className="field-hint">
                    Để hệ thống nhận ra và loại bài của người cùng nghề đăng tìm khách.
                  </span>
                </div>
              </div>

              <div className="field-group">
                <label className="field-label" htmlFor="radar-desc-textarea">
                  Câu mô tả chi tiết thứ cần tìm
                </label>
                <textarea
                  id="radar-desc-textarea"
                  className="textarea"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Mô tả rõ đối tượng, khu vực, tầm giá hoặc đặc điểm tin bạn muốn bắt…"
                />
              </div>

              <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="field-label">Ý định bài viết cần bắt:</span>
                  <select
                    aria-label="Ý định bài viết cần bắt"
                    className="select"
                    style={{ width: 240 }}
                    value={wantIntent}
                    onChange={(e) => setWantIntent(e.target.value as WantIntent)}
                  >
                    <option value="demand">Khách cần mua / thuê / tìm (demand)</option>
                    <option value="supply">Người bán / cho thuê / tìm việc (supply)</option>
                    <option value="any">Cả hai chiều / ghép chuyến (any)</option>
                  </select>
                </div>

                <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={excludePeers}
                    onChange={(e) => setExcludePeers(e.target.checked)}
                  />
                  <span>Tự động loại bài của người cùng nghề (`peer`)</span>
                </label>
              </div>
            </div>
          )}

          {/* STEP 2: TRƯỜNG */}
          {step === 2 && (
            <div>
              <div className="toolbar-row" style={{ justifyContent: "space-between" }}>
                <div>
                  <strong>Danh sách trường thông tin sẽ trích từ mỗi bài khớp</strong>
                  <div className="field-hint">
                    Giới hạn gói {license.plan === "pro" ? "Chuyên nghiệp" : "Cá nhân"}:{" "}
                    <strong>
                      {fields.length} / {maxFields} trường
                    </strong>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    className="btn"
                    disabled={suggesting}
                    onClick={() => void runSuggestFields(true)}
                  >
                    {suggesting ? "⏳ AI đang phân tích mô tả…" : "✨ Đề xuất lại bằng AI"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={fields.length >= maxFields}
                    title={
                      fields.length >= maxFields
                        ? `Gói hiện tại giới hạn tối đa ${maxFields} trường`
                        : "Thêm trường tuỳ chỉnh"
                    }
                    onClick={addField}
                  >
                    + Thêm trường
                  </button>
                </div>
              </div>

              {suggesting && (
                <div className="health-banner info" style={{ borderRadius: 6, marginBottom: 12 }}>
                  <span>Đang gọi AI đề xuất các trường phù hợp với câu mô tả của bạn (2–10 giây)…</span>
                </div>
              )}

              {!clarifyingDismissed && clarifyingQuestions.length > 0 && (
                <div className="card" style={{ background: "#fffbeb", borderColor: "#fde68a", marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <strong>Gợi ý làm rõ thêm từ AI (không bắt buộc):</strong>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setClarifyingDismissed(true)}
                    >
                      Bỏ qua gợi ý
                    </button>
                  </div>
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                    {clarifyingQuestions.map((q) => (
                      <li key={q}>{q}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="table-wrap">
                <table className="crm-table">
                  <thead>
                    <tr>
                      <th style={{ width: 68 }}>Thứ tự</th>
                      <th style={{ width: 170 }}>Tên trường</th>
                      <th style={{ width: 165 }}>Kiểu dữ liệu</th>
                      <th>Mô tả cho AI & Lựa chọn</th>
                      <th style={{ width: 85 }}>Bắt buộc</th>
                      <th style={{ width: 105 }}>Báo Telegram</th>
                      <th style={{ width: 65 }}>Xoá</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fields.map((f, idx) => (
                      <tr key={`${f.key}-${idx}`}>
                        <td>
                          <div style={{ display: "flex", gap: 3 }}>
                            <button
                              type="button"
                              className="btn btn-sm"
                              aria-label={`Đưa trường ${f.label} lên`}
                              disabled={idx === 0}
                              onClick={() => moveField(idx, -1)}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm"
                              aria-label={`Đưa trường ${f.label} xuống`}
                              disabled={idx === fields.length - 1}
                              onClick={() => moveField(idx, 1)}
                            >
                              ↓
                            </button>
                          </div>
                        </td>
                        <td>
                          <input
                            type="text"
                            aria-label={`Tên trường ${idx + 1}`}
                            className="input"
                            value={f.label}
                            onChange={(e) =>
                              updateField(idx, {
                                label: e.target.value,
                                key: f.key.startsWith("custom_field_")
                                  ? slugifyFieldKey(e.target.value, idx + 1)
                                  : f.key,
                              })
                            }
                          />
                          <div className="field-hint">
                            <code>{f.key}</code>
                          </div>
                        </td>
                        <td>
                          <select
                            aria-label={`Kiểu trường ${f.label}`}
                            className="select"
                            value={f.type}
                            onChange={(e) => updateField(idx, { type: e.target.value as FieldType })}
                          >
                            {(Object.keys(FIELD_TYPE_LABELS) as FieldType[]).map((ft) => (
                              <option key={ft} value={ft}>
                                {FIELD_TYPE_LABELS[ft]}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            type="text"
                            aria-label={`Mô tả trường ${f.label}`}
                            className="input"
                            value={f.description}
                            onChange={(e) => updateField(idx, { description: e.target.value })}
                          />
                          {(f.type === "enum" || f.type === "multi_enum") && (
                            <input
                              type="text"
                              aria-label={`Các lựa chọn cho ${f.label}`}
                              className="input"
                              style={{ marginTop: 5 }}
                              placeholder="Các giá trị cách nhau bằng dấu phẩy: thuê, mua"
                              value={(f.options ?? []).join(", ")}
                              onChange={(e) =>
                                updateField(idx, {
                                  options: e.target.value
                                    .split(",")
                                    .map((s) => s.trim())
                                    .filter(Boolean),
                                })
                              }
                            />
                          )}
                        </td>
                        <td style={{ textAlign: "center" }}>
                          <input
                            type="checkbox"
                            aria-label={`Bắt buộc ${f.label}`}
                            checked={f.required}
                            onChange={(e) => updateField(idx, { required: e.target.checked })}
                          />
                        </td>
                        <td style={{ textAlign: "center" }}>
                          <input
                            type="checkbox"
                            aria-label={`Hiện trong tin báo ${f.label}`}
                            checked={f.show_in_alert}
                            onChange={(e) => updateField(idx, { show_in_alert: e.target.checked })}
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-sm"
                            aria-label={`Xoá trường ${f.label}`}
                            onClick={() => removeField(idx)}
                          >
                            Xoá
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="field-hint" style={{ marginTop: 8 }}>
                Trường hệ thống luôn có sẵn (không tính vào giới hạn): <code>summary</code> (tóm tắt
                1 dòng), <code>intent</code>, <code>author_role</code>, <code>score</code>,{" "}
                <code>reason</code>.
              </div>
            </div>
          )}

          {/* STEP 3: NGUỒN */}
          {step === 3 && (
            <div>
              <div className="toolbar-row" style={{ justifyContent: "space-between" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flex: 1 }}>
                  <input
                    type="search"
                    className="input"
                    style={{ maxWidth: 340 }}
                    placeholder="Tìm group theo tên…"
                    value={sourceQuery}
                    onChange={(e) => setSourceQuery(e.target.value)}
                  />
                  <span className="badge badge-primary">
                    Đã chọn {selectedSourceIds.length} group · Tổng theo dõi:{" "}
                    {totalSelectedFollowed} / {maxGroups} group (Gói{" "}
                    {license.plan === "pro" ? "Chuyên nghiệp" : "Cá nhân"})
                  </span>
                </div>

                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={async () => {
                      const list = await api.sourceList();
                      setSources(list);
                    }}
                  >
                    Làm mới danh sách
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => openSafeSetupUrl("https://www.facebook.com/groups/joins/")}
                  >
                    Mở trang group của tôi trên Facebook
                  </button>
                </div>
              </div>

              {filteredSources.length === 0 ? (
                <div className="card" style={{ textAlign: "center", padding: 32 }}>
                  <p style={{ marginTop: 0 }}>
                    Extension chưa phát hiện group nào hoặc không khớp từ khoá tìm kiếm.
                  </p>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => openSafeSetupUrl("https://www.facebook.com/groups/joins/")}
                  >
                    Mở trang group của tôi trên Facebook
                  </button>
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="crm-table">
                    <thead>
                      <tr>
                        <th style={{ width: 52 }}>Chọn</th>
                        <th>Tên Group Facebook</th>
                        <th>Loại</th>
                        <th>Thành viên</th>
                        <th>Bài đã có trong kho</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredSources.map((src) => {
                        const checked = selectedSourceIds.includes(src.id);
                        return (
                          <tr key={src.id} onClick={() => toggleSource(src.id)} style={{ cursor: "pointer" }}>
                            <td onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                aria-label={`Chọn nguồn ${src.name}`}
                                checked={checked}
                                onChange={() => toggleSource(src.id)}
                              />
                            </td>
                            <td>
                              <strong>{src.name}</strong>
                            </td>
                            <td>
                              <span className="badge">
                                {src.privacy === "private" ? "Group kín" : "Công khai"}
                              </span>
                            </td>
                            <td>
                              {src.member_count
                                ? `${src.member_count.toLocaleString("vi-VN")} thành viên`
                                : "—"}
                            </td>
                            <td>{src.stored_post_count.toLocaleString("vi-VN")} bài</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* STEP 4: XEM THỬ VÀ BẬT */}
          {step === 4 && (
            <div>
              <div className="toolbar-row" style={{ justifyContent: "space-between" }}>
                <div>
                  <strong>
                    Kết quả xem thử trên bài thật{" "}
                    {previewState &&
                      `(${previewState.evaluated_posts} / ${previewState.total_posts} bài)`}
                  </strong>
                  <div className="field-hint">
                    Không tạo tin thật và không gửi Telegram. Bấm Đúng / Sai để dạy AI rồi bấm «Chạy lại».
                  </div>
                </div>
                <button
                  type="button"
                  className="btn"
                  disabled={previewLoading}
                  onClick={() => void startPreviewRun()}
                >
                  {previewLoading ? "Đang chấm thử…" : "↻ Chạy lại xem thử"}
                </button>
              </div>

              {previewState && previewState.status !== "done" && (
                <div className="health-banner info" style={{ borderRadius: 6, marginBottom: 12 }}>
                  <span>
                    Đang xử lý theo lô: đã chấm {previewState.evaluated_posts}/
                    {previewState.total_posts} bài — kết quả hiện dần ngay khi xong từng lô…
                  </span>
                </div>
              )}

              {/* Quality warnings (`02-radar-spec.md §5`) */}
              {previewState?.warnings.map((w, idx) => (
                <div
                  key={`${w.code}-${idx}`}
                  className="health-banner warning"
                  style={{ borderRadius: 6, marginBottom: 10 }}
                >
                  <span>⚠️ {w.message}</span>
                  {w.code === "missing_required_field" && w.field_key && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        const updated = fields.map((f) =>
                          f.key === w.field_key ? { ...f, required: false } : f
                        );
                        setFields(updated);
                        void startPreviewRun(updated);
                      }}
                    >
                      Bỏ bắt buộc «{w.field_label}» & Chạy lại
                    </button>
                  )}
                </div>
              ))}

              {/* Active radar version-upgrade confirmation (`02-radar-spec.md §4`) */}
              {isEditingActive && requiresVersionConfirm && (
                <label
                  className="card"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    background: "#eff6ff",
                    borderColor: "#93c5fd",
                    marginBottom: 12,
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={confirmedUpgrade}
                    onChange={(e) => setConfirmedUpgrade(e.target.checked)}
                  />
                  <span>
                    <strong>Xác nhận nâng cấp phiên bản Radar đang chạy:</strong> Trong lúc xem thử,
                    radar vẫn đang chạy phiên bản cũ (v{editRadar?.radar.current_version}). Đánh dấu
                    để áp dụng phiên bản mới (v{(editRadar?.radar.current_version ?? 1) + 1}) từ thời
                    điểm này trở đi.
                  </span>
                </label>
              )}

              <div className="preview-columns">
                {/* Column 1: KHỚP */}
                <div>
                  <div style={{ marginBottom: 8, display: "flex", justifyContent: "space-between" }}>
                    <strong style={{ color: "var(--success)" }}>
                      ✓ Khớp ({matchedPreviewItems.length})
                    </strong>
                    <span className="field-hint">Sắp xếp theo điểm giảm dần</span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {matchedPreviewItems.map((it) => {
                      const spans = fields
                        .map((fd) => {
                          const ef = it.fields[fd.key];
                          return ef?.raw ? { raw: ef.raw, fieldLabel: fd.label } : null;
                        })
                        .filter((x): x is { raw: string; fieldLabel: string } => Boolean(x));

                      return (
                        <div key={it.evaluation_id} className="card">
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                            <span className="badge badge-success">
                              Điểm {(it.score * 100).toFixed(0)}% ·{" "}
                              {it.decided_by === "rule" ? "Bộ luật" : "AI"}
                            </span>
                            <span className="field-hint">
                              {it.author_name} · {it.source_name}
                            </span>
                          </div>
                          <div style={{ fontWeight: 600, margin: "6px 0 4px" }}>{it.summary}</div>
                          <div className="field-hint" style={{ marginBottom: 6 }}>
                            Lý do: {it.reason}
                          </div>

                          <div
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              gap: 6,
                              marginBottom: 8,
                            }}
                          >
                            {fields.map((fd) => {
                              const ef = it.fields[fd.key];
                              if (!ef) return null;
                              return (
                                <span key={fd.key} className="badge badge-primary">
                                  {fd.label}: {formatExtractedFieldValue(fd, ef)}
                                </span>
                              );
                            })}
                          </div>

                          <div className="post-plain-text" style={{ fontSize: 12.5, padding: 9 }}>
                            {renderHighlightedPostText(it.post_text, spans)}
                          </div>

                          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                            <button
                              type="button"
                              className={`btn btn-sm ${
                                it.feedback_label === "correct" ? "btn-success" : ""
                              }`}
                              onClick={() => void handlePreviewFeedback(it, "correct")}
                            >
                              👍 Đúng
                            </button>
                            <button
                              type="button"
                              className={`btn btn-sm ${
                                it.feedback_label === "irrelevant" ? "btn-danger" : ""
                              }`}
                              onClick={() => void handlePreviewFeedback(it, "irrelevant")}
                            >
                              👎 Chấm sai
                            </button>
                          </div>
                        </div>
                      );
                    })}
                    {matchedPreviewItems.length === 0 && (
                      <div className="card text-muted">Chưa có bài khớp nào trong tập xem thử.</div>
                    )}
                  </div>
                </div>

                {/* Column 2: KHÔNG KHỚP */}
                <div>
                  <div style={{ marginBottom: 8, display: "flex", justifyContent: "space-between" }}>
                    <strong style={{ color: "var(--text-secondary)" }}>
                      ✕ Không khớp ({unmatchedPreviewItems.length})
                    </strong>
                    <span className="field-hint">Đã loại tự động</span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {unmatchedPreviewItems.map((it) => (
                      <div key={it.evaluation_id} className="card">
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                          <span className="badge">
                            Điểm {(it.score * 100).toFixed(0)}% ·{" "}
                            {it.decided_by === "rule" ? "Bộ luật" : "AI"}
                          </span>
                          <span className="field-hint">
                            {it.author_name} · {it.source_name}
                          </span>
                        </div>
                        <div style={{ fontWeight: 600, margin: "6px 0 4px" }}>{it.summary}</div>
                        <div className="field-hint" style={{ marginBottom: 6 }}>
                          Lý do loại: {it.reason}
                        </div>
                        <div className="post-plain-text" style={{ fontSize: 12.5, padding: 9 }}>
                          {renderHighlightedPostText(it.post_text, [])}
                        </div>
                        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                          <button
                            type="button"
                            className={`btn btn-sm ${
                              it.feedback_label === "correct" ? "btn-success" : ""
                            }`}
                            onClick={() => void handlePreviewFeedback(it, "correct")}
                          >
                            👍 Loại đúng
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={async () => {
                              await api.leadFeedback({
                                evaluation_id: it.evaluation_id,
                                post_id: it.post_id,
                                label: "missed",
                                origin: "preview",
                              });
                              setPreviewState((prev) =>
                                prev
                                  ? {
                                      ...prev,
                                      items: prev.items.map((x) =>
                                        x.evaluation_id === it.evaluation_id
                                          ? { ...x, feedback_label: "missed" }
                                          : x
                                      ),
                                    }
                                  : prev
                              );
                            }}
                          >
                            ⚠️ Đáng lẽ phải khớp
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <div>
            {step > 1 && (
              <button
                type="button"
                className="btn"
                onClick={() => setStep((s) => Math.max(1, s - 1) as 1 | 2 | 3 | 4)}
              >
                ← Quay lại bước {step - 1}
              </button>
            )}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            {step === 1 && (
              <button type="button" className="btn btn-primary" onClick={() => void goToStep2()}>
                Tiếp tục: Chọn trường →
              </button>
            )}
            {step === 2 && (
              <button type="button" className="btn btn-primary" onClick={goToStep3}>
                Tiếp tục: Chọn nguồn group →
              </button>
            )}
            {step === 3 && (
              <button type="button" className="btn btn-primary" onClick={() => void goToStep4()}>
                Tiếp tục: Xem thử trên bài thật →
              </button>
            )}
            {step === 4 && (
              <>
                <button
                  type="button"
                  className="btn"
                  disabled={saving}
                  onClick={() => void handleSaveRadar(false)}
                >
                  Lưu nháp
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={saving}
                  onClick={() => void handleSaveRadar(true)}
                >
                  {isEditingActive ? "Áp dụng & Bật radar" : "Bật radar"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
