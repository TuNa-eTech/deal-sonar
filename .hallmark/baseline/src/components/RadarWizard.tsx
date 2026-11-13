import React, { useEffect, useMemo, useRef, useState } from "react";
import { readWorkspace, saveWorkspace } from "../lib/workspace";
import { parseFieldValue } from "../lib/fieldValues";
import { OperationStatus } from "./OperationStatus";
import { api, onDesktopEvent } from "../lib/api";
import {
  composeTemplateDescription,
  FIELD_TYPE_LABELS,
  formatExtractedFieldValue,
  slugifyFieldKey,
} from "../lib/format";
import { openSafeSetupUrl, renderHighlightedPostText } from "../lib/security";
import type {
  Channel, HealthStatus, HardFilter, RadarNotifyConfig,
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
  const draftKey=`radar-draft-${editRadar?.radar.id ?? initialTemplate?.id ?? "new"}`;
  const restored=useMemo(()=>readWorkspace<Record<string,any>|null>(draftKey,null),[draftKey]);
  const version=editRadar?.pending_version_data ?? editRadar?.current_version_data;
  const [health,setHealth]=useState<HealthStatus|null>(null);
  const [channels,setChannels]=useState<Channel[]>([]);
  const [notify,setNotify]=useState<RadarNotifyConfig>(restored?.notify ?? editRadar?.radar.notify ?? {mode:"instant",channel_ids:[],min_score:0.6,quiet_hours:null});
  const [hardFilters,setHardFilters]=useState<HardFilter[]>(restored?.hardFilters ?? version?.match_policy.hard_filters ?? initialTemplate?.match_policy.hard_filters ?? []);
  const [showFields,setShowFields]=useState(false);
  const [templatesOpen,setTemplatesOpen]=useState(!initialTemplate&&!editRadar&&!restored);
  const [answers,setAnswers]=useState<Record<number,string>>({});
  const [readyAck,setReadyAck]=useState(false);
  const [previewTab,setPreviewTab]=useState<"match"|"no_match">("match");
  useEffect(()=>{void Promise.all([api.healthGet(),api.channelList(),api.settingsGet()]).then(([h,c,settings])=>{setHealth(h);setChannels(c);if(!editRadar&&!restored)setNotify(n=>({...n,mode:settings.default_notify_mode,channel_ids:c.filter(x=>x.state==="ok").map(x=>x.id)}));}).catch(err=>setErrorMsg(String(err)));},[]);
  const isEditingActive = editRadar?.radar.status === "active";

  const [step, setStep] = useState<1 | 2 | 3 | 4>(initialStep===4?4:restored?.step ?? initialStep);
  const [mode, setMode] = useState<"template" | "blank">(
    restored?.mode ?? (editRadar
      ? editRadar.radar.template_id
        ? "template"
        : "blank"
      : initialTemplate
        ? "template"
        : "template")
  );

  const defaultTpl =
    initialTemplate ??
    (editRadar?.radar.template_id
      ? templates.find((t) => t.id === editRadar.radar.template_id) ?? templates[0] ?? null
      : templates[0] ?? null);

  const [selectedTemplate, setSelectedTemplate] = useState<RadarTemplate | null>(
    restored?.selectedTemplate ?? (mode === "template" ? defaultTpl : null)
  );
  const [placeholderValues, setPlaceholderValues] = useState<Record<string, string>>(restored?.placeholderValues ?? {});

  const [radarName, setRadarName] = useState<string>(
    restored?.radarName ?? editRadar?.radar.name ?? defaultTpl?.name ?? ""
  );
  const [description, setDescription] = useState<string>(
    restored?.description ?? version?.description ??
      (defaultTpl ? composeTemplateDescription(defaultTpl, {}) : "")
  );
  const [userProfession, setUserProfession] = useState<string>(
    restored?.userProfession ?? version?.user_profession ?? defaultTpl?.user_profession ?? ""
  );
  const [wantIntent, setWantIntent] = useState<WantIntent>(
    restored?.wantIntent ?? version?.match_policy.want_intent ??
      defaultTpl?.match_policy.want_intent ??
      "demand"
  );
  const [excludePeers, setExcludePeers] = useState<boolean>(
    restored?.excludePeers ?? (editRadar
      ? version!.match_policy.exclude_roles.includes("peer")
      : (defaultTpl?.match_policy.exclude_roles.includes("peer") ?? true))
  );

  const [fields, setFields] = useState<FieldDef[]>(
    structuredClone(
      restored?.fields ?? version?.fields ?? defaultTpl?.fields ?? []
    )
  );
  const [suggesting, setSuggesting] = useState(false);
  const [clarifyingQuestions, setClarifyingQuestions] = useState<string[]>([]);
  const [clarifyingDismissed, setClarifyingDismissed] = useState(false);

  const [sources, setSources] = useState<Source[]>(initialSources);
  const [sourceQuery, setSourceQuery] = useState("");
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>(
    restored?.selectedSourceIds ?? editRadar?.radar.source_ids ?? []
  );

  const [draftRadarId, setDraftRadarId] = useState<string | null>(
    restored?.draftRadarId ?? editRadar?.radar.id ?? null
  );
  const [requiresVersionConfirm, setRequiresVersionConfirm] = useState(false);
  const [confirmedUpgrade, setConfirmedUpgrade] = useState(false);
  const [previewState, setPreviewState] = useState<PreviewRunState | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const startingPreview = useRef(false);
  const [previewSeconds, setPreviewSeconds] = useState(0);
  const [previewSyncError, setPreviewSyncError] = useState<string | null>(null);
  const previewRunning = previewState?.status === "crawling" || previewState?.status === "evaluating";
  const previewBusy = previewLoading || previewRunning;
  const evaluatedSignature=useRef<string|null>(null);
  const definitionSignature=JSON.stringify([description,userProfession,fields,wantIntent,excludePeers,hardFilters,selectedSourceIds]);
  useEffect(()=>{
    if(!previewBusy&&evaluatedSignature.current!==null&&evaluatedSignature.current!==definitionSignature){
      setPreviewState(null);setConfirmedUpgrade(false);setReadyAck(false);
    }
  },[definitionSignature,previewBusy]);



  useEffect(()=>{saveWorkspace(draftKey,{step,mode,selectedTemplate,placeholderValues,radarName,description,userProfession,wantIntent,excludePeers,fields,selectedSourceIds,draftRadarId,hardFilters,notify});},[draftKey,step,mode,selectedTemplate,placeholderValues,radarName,description,userProfession,wantIntent,excludePeers,fields,selectedSourceIds,draftRadarId,hardFilters,notify]);
  const maxFields = license.limits.max_fields_per_radar;
  const maxGroups = license.limits.max_followed_groups;

  const selectTemplate = (tpl: RadarTemplate) => {
    setHardFilters(structuredClone(tpl.match_policy.hard_filters));
    setMode("template");
    setTemplatesOpen(false);
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
      setHardFilters(res.hard_filters);
      setWantIntent(res.want_intent);
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
    let disposed = false;
    void onDesktopEvent("preview:progress", (ev) => {
      setPreviewState((prev) => {
        if (!prev || prev.preview_id !== ev.preview_id) return prev;
        if (!["crawling", "evaluating"].includes(prev.status) && ["crawling", "evaluating"].includes(ev.status)) return prev;
        if (ev.evaluated_posts < prev.evaluated_posts) return prev;
        const existingIds = new Set(prev.items.map((i) => i.evaluation_id));
        const mergedItems = [
          ...prev.items,
          ...ev.new_items.filter((i) => !existingIds.has(i.evaluation_id)),
        ];
        return {
          ...prev,
          status: ev.status,
          evaluated_posts: ev.evaluated_posts,
          failed_posts: ev.failed_posts ?? 0,
          error: ev.error ?? null,
          total_posts: ev.total_posts,
          items: mergedItems,
          warnings: ev.warnings,
        };
      });
      if (ev.status === "done" || ev.status === "error") {
        // A terminal event may arrive even when an earlier batch event was lost.
        void api.radarPreviewGet(ev.radar_id, ev.preview_id).then((snapshot) => {
          if (!disposed) setPreviewState((prev) => prev?.preview_id === ev.preview_id ? snapshot : prev);
        }).catch((err) => {
          if (!disposed) setPreviewSyncError(`Chưa lấy được kết quả đầy đủ: ${String(err)}`);
        });
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Events are best effort: a fast batch can finish before start() returns,
  // and a WebView can miss an event. Reconcile with the authoritative snapshot.
  useEffect(() => {
    if (!previewState || !previewRunning) return;
    const { radar_id, preview_id } = previewState;
    let disposed = false;
    let pending = false;
    const startedAt = Date.now();
    setPreviewSeconds(0);
    const timer = window.setInterval(() => {
      setPreviewSeconds(Math.floor((Date.now() - startedAt) / 1000));
      if (pending) return;
      pending = true;
      void api.radarPreviewGet(radar_id, preview_id).then((snapshot) => {
        if (disposed) return;
        setPreviewSyncError(null);
        setPreviewState((prev) => {
          if (prev?.preview_id !== preview_id || !["crawling", "evaluating"].includes(prev.status)) return prev;
          // Never regress a newer event when a snapshot request was in flight.
          if (snapshot.evaluated_posts < prev.evaluated_posts) return prev;
          const labels = new Map(prev.items.map((item) => [item.evaluation_id, item.feedback_label]));
          return { ...snapshot, items: snapshot.items.map((item) => ({ ...item,
            feedback_label: labels.get(item.evaluation_id) ?? item.feedback_label,
          })) };
        });
      }).catch((err) => {
        if (!disposed) setPreviewSyncError(`Chưa cập nhật được tiến độ: ${err instanceof Error ? err.message : String(err)}`);
      }).finally(() => { pending = false; });
    }, 1000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [previewState?.preview_id, previewRunning]);

  const stopPreview = async () => {
    if (!previewState) return;
    setPreviewLoading(true);
    try {
      const state = await api.radarPreviewCancel(previewState.radar_id, previewState.preview_id);
      setPreviewState(state);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally { setPreviewLoading(false); }
  };

  const currentMatchPolicy = (): MatchPolicy => ({
    want_intent: wantIntent,
    exclude_roles: excludePeers ? ["peer"] : [],
    hard_filters: hardFilters,
  });

  const startPreviewRun = async (overrideFields?: FieldDef[]) => {
    if (startingPreview.current || previewRunning) return;
    startingPreview.current = true;
    evaluatedSignature.current=JSON.stringify([description,userProfession,overrideFields??fields,wantIntent,excludePeers,hardFilters,selectedSourceIds]);
    setPreviewState(null);
    setPreviewSyncError(null);
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
          notify,
        });
        rId = created.radar.id;
        setDraftRadarId(rId);
      }
      setRequiresVersionConfirm(Boolean(editRadar));

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
      startingPreview.current = false;
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
    label: "correct" | "irrelevant" | "missed"
  ) => {
    setErrorMsg(null);
    try {
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
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSaveRadar = async (activate: boolean) => {
    if (previewBusy || saving) return;
    if (!description.trim() || !fields.length) {setErrorMsg("Hãy mô tả nhu cầu và chọn ít nhất một thông tin cần lấy.");return;}
    if (activate && (previewState?.status!=="done" || !previewState.total_posts || !selectedSourceIds.length)) {setErrorMsg("Cần hoàn tất xem thử trên bài thật trước khi bật. Bạn vẫn có thể lưu nháp.");return;}
    if (activate && health && (health.automatic_scanning!==true || !health.extension_connected || health.crawl_paused) && !readyAck) {setErrorMsg("Xác nhận chế độ hoạt động giới hạn trước khi bật radar.");return;}
    if (!activate && editRadar) {onClose();return;}
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
          notify,
        });
        rId = created.radar.id;
      } else {
        const latest=await api.radarGet(rId);
        const candidate=latest.pending_version_data;
        const same=candidate && candidate.description===description && JSON.stringify(candidate.fields)===JSON.stringify(normalizedFields) && JSON.stringify(candidate.match_policy)===JSON.stringify(currentMatchPolicy()) && candidate.user_profession===(userProfession.trim()||null);
        await api.radarUpdate({id:rId,name:radarName.trim()||"Radar mới",source_ids:selectedSourceIds,notify,
          ...(same && activate ? {} : {description,user_profession:userProfession.trim()||null,fields:normalizedFields,match_policy:currentMatchPolicy()}),
          confirm_version_upgrade:activate,
        });
      }

      if (activate) {
        await api.radarSetStatus(rId, "active");
      }
      saveWorkspace(draftKey,null);
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
      <div className="modal-panel radar-studio">
        <div className="modal-header radar-studio-header">
          <div>
            <span className="eyebrow">THIẾT LẬP TÌM CƠ HỘI</span>
            <h2 style={{ margin: 0, fontSize: 17 }}>
              {editRadar ? `Chỉnh sửa Radar: ${editRadar.radar.name}` : "Tạo Radar mới"}
            </h2>
            <div className="field-hint">
              Mô tả một lần. Kiểm tra kết quả thật trước khi bật radar.
            </div>
          </div>

            <button type="button" className="radar-close-button" aria-label="Đóng" title="Đóng" disabled={previewLoading || saving} onClick={() => {
              if (previewRunning) {
                void api.radarPreviewCancel(previewState!.radar_id, previewState!.preview_id).then(onClose).catch((err) => setErrorMsg(String(err)));
              } else onClose();
            }}>
              <span className="radar-close-label">Đóng</span><span aria-hidden="true">×</span>
            </button>

          <div className="radar-stepper" aria-label="Các bước tạo radar">
            {[
              { n: 1 as const, label: "1. Mô tả" },
              { n: 2 as const, label: "2. Cách hiểu" },
              { n: 3 as const, label: "3. Nguồn" },
              { n: 4 as const, label: "4. Xem thử và bật" },
            ].map((s) => (
              <button
                key={s.n}
                disabled={previewBusy || saving || s.n>step+1}
                aria-current={step===s.n?"step":undefined}
                type="button"
                className={`btn btn-sm ${step === s.n ? "btn-primary" : ""}`}
                onClick={() => {
                  if(s.n<=step)setStep(s.n);
                  else if(s.n===2)void goToStep2();
                  else if(s.n===3)goToStep3();
                  else void goToStep4();
                }}
              >
                <span className="radar-step-number">{s.n<step?"✓":s.n}</span><span>{s.label.replace(/^\d+\. /, "")}</span>
              </button>
            ))}

          </div>
        </div>

        <div className="radar-studio-workspace">
        <div className="modal-body radar-studio-body">
          <div className="radar-step-intro"><span className="eyebrow">BƯỚC {step} / 4</span><h3>{["Bạn đang tìm cơ hội nào?","Kiểm tra cách radar hiểu nhu cầu","Chọn nơi radar tìm bài","Kiểm tra kết quả trước khi bật"][step-1]}</h3><p>{["Chọn mẫu gần với công việc của bạn, rồi mô tả khu vực và nhu cầu cụ thể.","Xác nhận điều kiện bắt buộc. Các thông tin trích xuất đã có sẵn và có thể tùy chỉnh.","Chỉ chọn những nhóm phù hợp. Bạn có thể đổi danh sách này khi chỉnh radar.","Đọc các bài khớp và bị loại, sau đó chọn cách nhận tin phù hợp."][step-1]}</p></div>
          {step===1&&readWorkspace<string>("onboarding-goal","")&&<div className="card"><strong>Nhu cầu đã mô tả</strong><p>{readWorkspace<string>("onboarding-goal","")}</p><button className="btn" onClick={()=>{setDescription(readWorkspace<string>("onboarding-goal",""));setMode("blank");setFields([]);setHardFilters([]);}}>Dùng nhu cầu này và đề xuất bằng AI</button></div>}
          {errorMsg && (
            <div role="alert" className="health-banner danger" style={{ borderRadius: 6, marginBottom: 12 }}>
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
                    setTemplatesOpen(true);
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
                  {selectedTemplate&&!templatesOpen&&<div className="radar-selected-template"><div><span className="field-hint">Mẫu đang dùng · {selectedTemplate.industry}</span><strong>{selectedTemplate.name}</strong></div><button type="button" className="btn btn-sm" onClick={()=>setTemplatesOpen(true)}>Đổi mẫu</button></div>}
                  <div className="template-grid radar-template-grid" hidden={!templatesOpen} style={{ marginBottom: 14 }}>
                    {templates.map((tpl) => (
                      <button
                        key={tpl.id}
                        type="button"
                        aria-pressed={selectedTemplate?.id===tpl.id}
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


              <details className="radar-advanced"><summary>Đối tượng bài viết & Loại trừ người cùng nghề</summary><div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="field-label">Ý định bài viết cần bắt:</span>
                  <select
                    aria-label="Ý định bài viết cần bắt"
                    className="select"
                    style={{ width: 240 }}
                    value={wantIntent}
                    onChange={(e) => setWantIntent(e.target.value as WantIntent)}
                  >
                    <option value="demand">Khách cần mua / thuê / tìm</option>
                    <option value="supply">Người bán / cho thuê / tìm việc</option>
                    <option value="any">Cả hai chiều / ghép chuyến</option>
                  </select>
                </div>

                <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={excludePeers}
                    onChange={(e) => setExcludePeers(e.target.checked)}
                  />
                  <span>Loại bài chào bán của người cùng nghề</span>
                </label>
              </div></details>
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
                      <li key={q}><label>{q}<input className="input" value={answers[clarifyingQuestions.indexOf(q)]??""} onChange={e=>setAnswers(a=>({...a,[clarifyingQuestions.indexOf(q)]:e.target.value}))}/></label></li>
                    ))}
                  </ul>
                  <button className="btn btn-sm" onClick={()=>{setDescription(d=>d+"\n"+clarifyingQuestions.map((q,i)=>answers[i]?`${q}: ${answers[i]}`:"").filter(Boolean).join("\n"));setClarifyingDismissed(true);}}>Bổ sung vào mô tả</button>
                </div>
              )}

              <div className="intent-summary"><h3>Radar sẽ tìm điều gì?</h3><p>{description}</p><p>Hướng tìm: <strong>{wantIntent==="demand"?"Khách có nhu cầu":wantIntent==="supply"?"Người cung cấp / người bán":"Cả hai chiều"}</strong> · {excludePeers?"Loại bài người cùng nghề":"Giữ mọi vai trò"}</p>
                <h4>Điều kiện bắt buộc</h4><p className="field-hint">Mô tả giúp AI hiểu nhu cầu. Điều kiện bên dưới là giới hạn bắt buộc sau khi trích xuất.</p>
                {hardFilters.map((filter,index)=>{const fd=fields.find(f=>f.key===filter.field);return <div className="hard-filter-row" key={index}><select className="select" aria-label={`Trường điều kiện ${index+1}`} value={filter.field} onChange={e=>setHardFilters(xs=>xs.map((x,i)=>i===index?{...x,field:e.target.value,value:null}:x))}>{fields.map(f=><option key={f.key} value={f.key}>{f.label}</option>)}</select><select className="select" aria-label={`So sánh ${index+1}`} value={filter.op} onChange={e=>setHardFilters(xs=>xs.map((x,i)=>i===index?{...x,op:e.target.value as HardFilter["op"]}:x))}>{["eq","ne","lte","gte","contains","is_empty"].map(op=><option key={op} value={op}>{({eq:"Bằng",ne:"Khác",lte:"Không quá",gte:"Ít nhất",contains:"Chứa",is_empty:"Chưa có thông tin"} as Record<string,string>)[op]}</option>)}</select><input className="input" aria-label={`Giá trị điều kiện ${index+1}`} defaultValue={typeof filter.value==="object"?JSON.stringify(filter.value):String(filter.value??"")} onBlur={e=>{try{const raw=e.target.value;const val=fd&&["money","number","range"].includes(fd.type)?parseFieldValue({...fd,type:"number"},raw):raw;setHardFilters(xs=>xs.map((x,i)=>i===index?{...x,value:val}:x));}catch(err){setErrorMsg(String(err));}}}/><select className="select" aria-label={`Khi thiếu thông tin ${index+1}`} value={filter.when_missing} onChange={e=>setHardFilters(xs=>xs.map((x,i)=>i===index?{...x,when_missing:e.target.value as "pass"|"fail"}:x))}><option value="pass">Thiếu thông tin: giữ lại</option><option value="fail">Thiếu thông tin: loại</option></select><button className="btn btn-sm" onClick={()=>setHardFilters(xs=>xs.filter((_,i)=>i!==index))}>Bỏ</button></div>;})}
                <button className="btn btn-sm" disabled={!fields.length} onClick={()=>setHardFilters(xs=>[...xs,{field:fields[0]!.key,op:"eq",value:"",when_missing:"pass"}])}>+ Điều kiện bắt buộc</button>
              </div>
              <button className="btn" aria-expanded={showFields} onClick={()=>setShowFields(v=>!v)}>{showFields?"Thu gọn":"Tùy chỉnh"} thông tin cần lấy ({fields.length} trường)</button>
              <div hidden={!showFields}>
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
                    Không tạo cơ hội thật hoặc gửi thông báo. Phản hồi được lưu làm ví dụ; chạy lại để kiểm tra kết quả mới.
                  </div>
                </div>
                <button
                  type="button"
                  className="btn"
                  disabled={previewBusy || saving}
                  onClick={() => void startPreviewRun()}
                >
                  {previewLoading ? "Đang chấm thử…" : "↻ Chạy lại xem thử"}
                </button>
              </div>

              {previewRunning && (
                <div className="health-banner info" style={{ borderRadius: 6, marginBottom: 12 }}>
                  <span>
                    {previewState?.status === "crawling"
                      ? "Đang lấy bài từ Chrome; chờ tối đa 30 giây…"
                      : `Đang chấm AI theo lô: đã chấm ${previewState?.evaluated_posts}/${previewState?.total_posts} bài. Lô đầu có thể mất tới 2 phút.`}
                    {` Đã chờ ${previewSeconds} giây.`}
                  </span>
                </div>
              )}

              {previewRunning && (
                <button type="button" className="btn btn-sm" disabled={previewLoading} onClick={() => void stopPreview()}>
                  Dừng xem thử
                </button>
              )}
              {previewSyncError && <div role="status" className="health-banner warning">{previewSyncError}</div>}
              {previewState?.status === "error" && (
                <div role="alert" className="health-banner danger">
                  {previewState.error || "Không chấm được bài. Hãy kiểm tra kết nối AI rồi chạy lại."}
                  {` Đã chấm ${previewState.evaluated_posts}/${previewState.total_posts} bài; ${previewState.failed_posts ?? 0} bài lỗi.`}
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

              <OperationStatus health={health}/>
              <div className="card notification-setup"><h3>Khi bật radar này</h3><p>{selectedSourceIds.length} nhóm · {fields.length} thông tin · {hardFilters.length} điều kiện bắt buộc. {editRadar?`Đang chỉnh radar “${editRadar.radar.name}”; chỉ áp dụng khi bấm nút cuối.`:"Bản nháp chưa tự thu thập bài."}</p>
                <label>Chế độ thông báo<select className="select" value={notify.mode} onChange={e=>setNotify(n=>({...n,mode:e.target.value as "instant"|"digest"}))}><option value="instant">Báo ngay</option><option value="digest">Gửi gộp</option></select></label>
                <label>Điểm tối thiểu để báo<input className="input" type="number" min={0.4} max={1} step={0.05} value={notify.min_score} onChange={e=>setNotify(n=>({...n,min_score:Number(e.target.value)}))}/></label>
                <p className="field-hint">Điểm phù hợp dùng để ưu tiên, không phải xác suất đúng. Cơ hội dưới ngưỡng vẫn có thể xem trong ứng dụng.</p>
                <fieldset><legend>Kênh nhận của radar này</legend>{channels.map(c=><label key={c.id}><input type="checkbox" checked={notify.channel_ids.includes(c.id)} onChange={e=>setNotify(n=>({...n,channel_ids:e.target.checked?[...n.channel_ids,c.id]:n.channel_ids.filter(id=>id!==c.id)}))}/>{c.name} {c.state!=="ok"?"(cần kết nối lại)":""}</label>)}{channels.length===0&&<p>Chưa có kênh ngoài. Xem cơ hội trong ứng dụng và dùng thông báo màn hình theo Cài đặt.</p>}</fieldset>
                {(health?.automatic_scanning!==true||!health?.extension_connected||health?.crawl_paused)&&<label><input type="checkbox" checked={readyAck} onChange={e=>setReadyAck(e.target.checked)}/> Tôi hiểu radar đã bật chưa đồng nghĩa đang quét. Tôi sẽ mở tiện ích và bật quét tự động hoặc quét thủ công.</label>}
              </div>
              <div className="section-tabs"><button className={`btn ${previewTab==="match"?"btn-primary":""}`} onClick={()=>setPreviewTab("match")}>Khớp ({matchedPreviewItems.length})</button><button className={`btn ${previewTab==="no_match"?"btn-primary":""}`} onClick={()=>setPreviewTab("no_match")}>Bị loại ({unmatchedPreviewItems.length})</button></div>
              <div className="preview-columns">
                {/* Column 1: KHỚP */}
                <div hidden={previewTab!=="match"}>
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
                <div hidden={previewTab!=="no_match"}>
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
                            onClick={() => void handlePreviewFeedback(it, "missed")}
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

        <aside className="radar-live-summary" aria-label="Tóm tắt radar đang tạo"><span className="eyebrow">RADAR CỦA BẠN</span><h3>{radarName.trim()||"Radar chưa đặt tên"}</h3><p className="radar-summary-description">{description.trim()||"Mô tả nhu cầu để bắt đầu tìm đúng cơ hội."}</p><dl><div><dt>Thông tin cần lấy</dt><dd>{fields.length} trường</dd></div><div><dt>Điều kiện bắt buộc</dt><dd>{hardFilters.length?`${hardFilters.length} điều kiện`:"Theo mô tả"}</dd></div><div><dt>Nguồn đã chọn</dt><dd>{selectedSourceIds.length} nhóm</dd></div><div><dt>Cách nhận tin</dt><dd>{notify.mode==="digest"?"Gửi gộp":"Báo ngay"}</dd></div></dl>{selectedSourceIds.length>0&&<div className="radar-source-chips">{sources.filter(source=>selectedSourceIds.includes(source.id)).slice(0,3).map(source=><span key={source.id}>{source.name}</span>)}{selectedSourceIds.length>3&&<small>Và {selectedSourceIds.length-3} nhóm khác</small>}</div>}<div className="radar-draft-note"><strong>● Bản nhập tự lưu trên máy</strong><p>Chưa áp dụng cho đến khi bạn xác nhận. Xem thử không gửi thông báo.</p></div></aside>
        </div>
        <div className="modal-footer radar-studio-footer">
          <div>
            {step===1&&<span className="field-hint">Bạn có thể đóng và tiếp tục bản nhập sau.</span>}
            {step > 1 && (
              <button
                type="button"
                className="btn"
                disabled={previewBusy || saving}
                onClick={() => setStep((s) => Math.max(1, s - 1) as 1 | 2 | 3 | 4)}
              >
                ← Quay lại bước {step - 1}
              </button>
            )}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            {step!==4&&<button className="btn" disabled={saving||previewBusy} onClick={onClose}>Lưu bản nhập & Đóng</button>}
            {step === 1 && (
              <button type="button" className="btn btn-primary" onClick={() => void goToStep2()}>
                Tiếp tục: Xác nhận cách hiểu →
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
                  disabled={saving || previewBusy}
                  onClick={() => void handleSaveRadar(false)}
                >
                  Lưu nháp
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={saving || previewBusy || previewState?.status!=="done" || !previewState.total_posts}
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
