// State, side effects, and actions for the radar wizard.

import { useEffect, useMemo, useRef, useState } from "react";
import { readWorkspace, saveWorkspace } from "../../lib/workspace";
import { api, onDesktopEvent } from "../../lib/api";
import { composeTemplateDescription, slugifyFieldKey } from "../../lib/format";
import type {
  Channel,
  HealthStatus,
  HardFilter,
  RadarNotifyConfig,
  FieldDef,
  LicenseStatus,
  MatchPolicy,
  PreviewItem,
  PreviewRunState,
  RadarDetail,
  RadarTemplate,
  Source,
  WantIntent,
} from "../../types/ipc";

export interface RadarWizardProps {
  templates: RadarTemplate[];
  sources: Source[];
  license: LicenseStatus;
  initialTemplate?: RadarTemplate | null;
  editRadar?: RadarDetail | null;
  initialStep?: 1 | 2 | 3 | 4;
  onClose: () => void;
  onSaved: (radarId: string) => void;
}

export function useRadarWizard({
  templates,
  sources: initialSources,
  license,
  initialTemplate = null,
  editRadar = null,
  initialStep = 1,
  onClose,
  onSaved,
}: RadarWizardProps) {
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

  return {
    templates,
    license,
    initialTemplate,
    editRadar,
    initialStep,
    onClose,
    onSaved,
    draftKey,
    restored,
    version,
    health,
    setHealth,
    channels,
    setChannels,
    notify,
    setNotify,
    hardFilters,
    setHardFilters,
    showFields,
    setShowFields,
    templatesOpen,
    setTemplatesOpen,
    answers,
    setAnswers,
    readyAck,
    setReadyAck,
    previewTab,
    setPreviewTab,
    isEditingActive,
    step,
    setStep,
    mode,
    setMode,
    defaultTpl,
    selectedTemplate,
    setSelectedTemplate,
    placeholderValues,
    setPlaceholderValues,
    radarName,
    setRadarName,
    description,
    setDescription,
    userProfession,
    setUserProfession,
    wantIntent,
    setWantIntent,
    excludePeers,
    setExcludePeers,
    fields,
    setFields,
    suggesting,
    setSuggesting,
    clarifyingQuestions,
    setClarifyingQuestions,
    clarifyingDismissed,
    setClarifyingDismissed,
    sources,
    setSources,
    sourceQuery,
    setSourceQuery,
    selectedSourceIds,
    setSelectedSourceIds,
    draftRadarId,
    setDraftRadarId,
    requiresVersionConfirm,
    setRequiresVersionConfirm,
    confirmedUpgrade,
    setConfirmedUpgrade,
    previewState,
    setPreviewState,
    previewLoading,
    setPreviewLoading,
    errorMsg,
    setErrorMsg,
    saving,
    setSaving,
    startingPreview,
    previewSeconds,
    setPreviewSeconds,
    previewSyncError,
    setPreviewSyncError,
    previewRunning,
    previewBusy,
    evaluatedSignature,
    definitionSignature,
    maxFields,
    maxGroups,
    selectTemplate,
    handlePlaceholderChange,
    runSuggestFields,
    goToStep2,
    goToStep3,
    stopPreview,
    currentMatchPolicy,
    startPreviewRun,
    goToStep4,
    updateField,
    moveField,
    addField,
    removeField,
    toggleSource,
    handlePreviewFeedback,
    handleSaveRadar,
    filteredSources,
    totalSelectedFollowed,
    matchedPreviewItems,
    unmatchedPreviewItems,
  };
}

export type RadarWizardModel = ReturnType<typeof useRadarWizard>;
