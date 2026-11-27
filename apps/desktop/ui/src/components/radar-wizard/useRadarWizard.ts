// State, side effects, and actions for the radar wizard.

import { useEffect, useMemo, useRef, useState } from "react";
import { readWorkspace, saveWorkspace } from "../../lib/workspace";
import { api, onDesktopEvent } from "../../lib/api";
import { offerUndo } from "../UndoCenter";
import { composeTemplateDescription, slugifyFieldKey } from "../../lib/format";
import type {
  Channel,
  HealthStatus,
  HardFilter,
  FilterExpr,
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
  initialGoal?: string;
  initialTemplate?: RadarTemplate | null;
  editRadar?: RadarDetail | null;
  initialStep?: 1 | 2 | 3 | 4;
  onClose: () => void;
  onSaved: (radarId: string) => void;
  /** Gọi khi dữ liệu radar đổi ngoài wizard (ví dụ sau khi hoàn tác). */
  onRadarChanged?: () => void;
}

interface RadarPreviewPlan {
  name: string;
  fields: FieldDef[];
  matchPolicy: MatchPolicy;
  sourceIds: string[];
}

export function useRadarWizard({
  templates,
  sources: initialSources,
  license,
  initialTemplate = null,
  initialGoal = "",
  editRadar = null,
  initialStep = 1,
  onClose,
  onSaved,
  onRadarChanged,
}: RadarWizardProps) {
  const draftKey=`radar-draft-${editRadar?.radar.id ?? initialTemplate?.id ?? "new"}`;
  const restored=useMemo(()=>readWorkspace<Record<string,any>|null>(draftKey,null),[draftKey]);
  const version=editRadar?.pending_version_data ?? editRadar?.current_version_data;
  const [health,setHealth]=useState<HealthStatus|null>(null);
  const [channels,setChannels]=useState<Channel[]>([]);
  const [notify,setNotify]=useState<RadarNotifyConfig>(restored?.notify ?? editRadar?.radar.notify ?? {mode:initialTemplate?.notify_mode ?? "instant",inherit_channels:false,channel_ids:[],min_score:0.6,quiet_hours:null,lead_ttl_hours:initialTemplate?.lead_ttl_hours ?? null});
  const [hardFilters,setHardFilters]=useState<HardFilter[]>(restored?.hardFilters ?? version?.match_policy.hard_filters ?? initialTemplate?.match_policy.hard_filters ?? []);
  // Biểu thức nhóm (all/any/not) chưa có trình soạn thảo trong wizard: giữ nguyên khi lưu để không mất.
  const [condition,setCondition]=useState<FilterExpr|null>(version?.match_policy.condition ?? initialTemplate?.match_policy.condition ?? null);
  // Bài người dùng đánh dấu «Đáng lẽ phải khớp»: giữ lại qua các lần chạy lại để kiểm tra sau khi sửa điều kiện.
  const [missedPostIds,setMissedPostIds]=useState<string[]>([]);
  const [showFields,setShowFields]=useState(false);
  const [templatesOpen,setTemplatesOpen]=useState(!initialTemplate&&!editRadar&&!restored);
  const [answers,setAnswers]=useState<Record<number,string>>({});
  const [readyAck,setReadyAck]=useState(false);
  const [previewTab,setPreviewTab]=useState<"match"|"no_match">("match");
  useEffect(()=>{void Promise.all([api.healthGet(),api.channelList(),api.settingsGet()]).then(([h,c,settings])=>{setHealth(h);setChannels(c);if(!editRadar&&!restored)setNotify(n=>({...n,mode:initialTemplate?.notify_mode ?? settings.default_notify_mode}));}).catch(err=>setErrorMsg(String(err)));},[]);
  const isEditingActive = editRadar?.radar.status === "active";

  const [step, setStep] = useState<1 | 4>(initialStep === 4 ? 4 : 1);
  const [mode, setMode] = useState<"template" | "blank">(
    restored?.mode ?? (editRadar
      ? editRadar.radar.template_id
        ? "template"
        : "blank"
      : initialTemplate
        ? "template"
        : "blank")
  );

  const defaultTpl =
    initialTemplate ??
    (editRadar?.radar.template_id
      ? templates.find((t) => t.id === editRadar.radar.template_id) ?? null
      : null);

  const [selectedTemplate, setSelectedTemplate] = useState<RadarTemplate | null>(
    restored?.selectedTemplate ?? (mode === "template" ? defaultTpl : null)
  );
  const [placeholderValues, setPlaceholderValues] = useState<Record<string, string>>(restored?.placeholderValues ?? {});

  const [radarName, setRadarName] = useState<string>(
    restored?.radarName ?? editRadar?.radar.name ?? defaultTpl?.name ?? ""
  );
  const [description, setDescription] = useState<string>(
    restored?.description ?? version?.description ??
      (initialGoal || (defaultTpl ? composeTemplateDescription(defaultTpl, {}) : ""))
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
  const suggestionInFlight = useRef(false);
  const preparing = useRef(false);
  const [analyzedDescription, setAnalyzedDescription] = useState<string | null>(restored?.analyzedDescription ?? null);
  const [clarifyingQuestions, setClarifyingQuestions] = useState<string[]>([]);
  const [clarifyingDismissed, setClarifyingDismissed] = useState(false);

  const [sources, setSources] = useState<Source[]>(initialSources);
  const [sourceQuery, setSourceQuery] = useState("");
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>(
    restored?.selectedSourceIds ?? editRadar?.radar.source_ids ?? []
  );
  const [sourcesOpen, setSourcesOpen] = useState(initialStep === 3);
  const [sourcesManual, setSourcesManual] = useState(restored?.sourcesManual ?? Boolean(editRadar?.radar.source_ids.length));
  const [sourcesSuggested, setSourcesSuggested] = useState(restored?.sourcesSuggested ?? false);

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
  const attachedPreview = useRef(false);
  const activePreviewId = useRef<string | null>(null);
  const [previewSeconds, setPreviewSeconds] = useState(0);
  const [previewSyncError, setPreviewSyncError] = useState<string | null>(null);
  const previewRunning = previewState?.status === "crawling" || previewState?.status === "evaluating";
  const previewBusy = previewLoading || previewRunning;
  const evaluatedSignature=useRef<string|null>(null);
  const definitionSignature=JSON.stringify([description,userProfession,fields,wantIntent,excludePeers,hardFilters,condition,selectedSourceIds]);
  useEffect(()=>{
    if(!previewBusy&&evaluatedSignature.current!==null&&evaluatedSignature.current!==definitionSignature){
      activePreviewId.current = null;
      setPreviewState(null);setConfirmedUpgrade(false);setReadyAck(false);
    }
  },[definitionSignature,previewBusy]);



  useEffect(()=>{
    saveWorkspace(draftKey,{step,mode,selectedTemplate,placeholderValues,radarName,description,userProfession,wantIntent,excludePeers,fields,selectedSourceIds,draftRadarId,hardFilters,notify,analyzedDescription,sourcesManual,sourcesSuggested});
  },[draftKey,step,mode,selectedTemplate,placeholderValues,radarName,description,userProfession,wantIntent,excludePeers,fields,selectedSourceIds,draftRadarId,hardFilters,notify,analyzedDescription,sourcesManual,sourcesSuggested]);
  const maxFields = license.limits.max_fields_per_radar;
  const maxGroups = license.limits.max_followed_groups;
  const descriptionKey = JSON.stringify([description.trim(), userProfession.trim(), selectedTemplate?.id ?? null]);

  const selectTemplate = (tpl: RadarTemplate) => {
    setHardFilters(structuredClone(tpl.match_policy.hard_filters));
    setCondition(structuredClone(tpl.match_policy.condition ?? null));
    setMode("template");
    setTemplatesOpen(false);
    setSelectedTemplate(tpl);
    setPlaceholderValues({});
    setRadarName(tpl.name);
    setDescription(initialGoal || composeTemplateDescription(tpl, {}));
    setUserProfession(tpl.user_profession);
    setWantIntent(tpl.match_policy.want_intent);
    setExcludePeers(tpl.match_policy.exclude_roles.includes("peer"));
    setFields(structuredClone(tpl.fields).slice(0, maxFields));
    // Each trade has its own clock: a bargain car is gone in hours, a job seeker stays for weeks.
    setNotify((n) => ({ ...n, lead_ttl_hours: tpl.lead_ttl_hours ?? null, mode: tpl.notify_mode ?? n.mode }));
  };

  const startBlank = () => {
    setMode("blank");
    setSelectedTemplate(null);
    setPlaceholderValues({});
    setRadarName("");
    setDescription(initialGoal);
    setUserProfession("");
    setWantIntent("demand");
    setExcludePeers(true);
    setFields([]);
    setHardFilters([]);
    setNotify(n => ({ ...n, lead_ttl_hours: null }));
  };

  const handlePlaceholderChange = (key: string, val: string) => {
    const next = { ...placeholderValues, [key]: val };
    setPlaceholderValues(next);
    if (selectedTemplate) {
      const lastGenerated = composeTemplateDescription(selectedTemplate, placeholderValues);
      if (!description.trim() || description === lastGenerated) {
        setDescription(composeTemplateDescription(selectedTemplate, next));
      }
      const areaHint = next["khu vực"] || next["tuyến đường"] || next["dòng hàng"] || next["vị trí"];
      const lastArea = placeholderValues["khu vực"] || placeholderValues["tuyến đường"] || placeholderValues["dòng hàng"] || placeholderValues["vị trí"];
      const lastName = lastArea?.trim() ? `${selectedTemplate.name} — ${lastArea.trim()}`.slice(0, 60) : selectedTemplate.name;
      if (areaHint?.trim() && (!radarName.trim() || radarName === lastName)) {
        setRadarName(`${selectedTemplate.name} — ${areaHint.trim()}`.slice(0, 60));
      }
    }
  };

  const runSuggestFields = async (forceReplace: boolean): Promise<RadarPreviewPlan | null> => {
    if (suggestionInFlight.current) return null;
    if (!description.trim()) {
      setErrorMsg("Hãy mô tả điều bạn muốn tìm để AI phân tích.");
      return null;
    }
    suggestionInFlight.current = true;
    setSuggesting(true);
    setErrorMsg(null);
    try {
      const [res, latestSources] = await Promise.all([
        api.radarSuggestFields({
          description,
          user_profession: userProfession || null,
          template_id: mode === "template" ? selectedTemplate?.id ?? null : null,
          language_hint: "vi",
          suggest_sources: !sourcesManual,
        }),
        sourcesManual ? Promise.resolve(sources) : api.sourceList(),
      ]);
      const plan = getPreviewPlan();
      if (forceReplace || !fields.length) {
        plan.fields = res.fields.slice(0, maxFields);
        plan.matchPolicy.want_intent = res.want_intent;
        plan.matchPolicy.hard_filters = res.hard_filters.filter(filter =>
          plan.fields.some(field => field.key === filter.field));
        setFields(plan.fields);
        setHardFilters(plan.matchPolicy.hard_filters);
        setWantIntent(plan.matchPolicy.want_intent);
      }
      if (!radarName.trim()) setRadarName(plan.name = res.suggested_name);
      if (!sourcesManual) {
        plan.sourceIds = (res.suggested_source_ids ?? []).filter(id =>
          latestSources.some(source => source.id === id && source.state === "ok"));
        setSources(latestSources);
        setSelectedSourceIds(plan.sourceIds);
        setSourcesSuggested(Boolean(plan.sourceIds.length));
        if (!plan.sourceIds.length) setSourcesOpen(true);
      }
      setAnalyzedDescription(descriptionKey);
      setClarifyingQuestions(res.clarifying_questions ?? []);
      setClarifyingDismissed(false);
      setAnswers({});
      return plan;
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      suggestionInFlight.current = false;
      setSuggesting(false);
    }
  };

  // Subscribe to streaming `preview:progress` events!
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void onDesktopEvent("preview:progress", (ev) => {
      if (activePreviewId.current !== ev.preview_id) return;
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
    ...(condition ? { condition } : {}),
  });

  const getPreviewPlan = (): RadarPreviewPlan => ({
    name: radarName.trim() || "Radar mới",
    fields, matchPolicy: currentMatchPolicy(), sourceIds: selectedSourceIds,
  });

  const startPreviewRun = async (overrideFields?: FieldDef[], plan = getPreviewPlan()) => {
    if (startingPreview.current || previewRunning) return;
    const previewFields = overrideFields ?? plan.fields;
    startingPreview.current = true;
    attachedPreview.current = false;
    activePreviewId.current = null;
    evaluatedSignature.current = JSON.stringify([
      description, userProfession, previewFields, plan.matchPolicy.want_intent,
      plan.matchPolicy.exclude_roles.includes("peer"), plan.matchPolicy.hard_filters,
      plan.matchPolicy.condition ?? null, plan.sourceIds,
    ]);
    setPreviewState(null);
    setPreviewSyncError(null);
    setPreviewLoading(true);
    setErrorMsg(null);
    const activeFields = previewFields.map((f, idx) => ({
      ...f,
      key: f.key || slugifyFieldKey(f.label, idx + 1),
      order: idx + 1,
    }));

    try {
      let rId = draftRadarId;
      const draftDefinition = {
        name: plan.name,
        description,
        user_profession: userProfession.trim() || null,
        fields: activeFields,
        match_policy: plan.matchPolicy,
        source_ids: plan.sourceIds,
        notify,
      };
      if (!rId) {
        const created = await api.radarCreateDraft({
          ...draftDefinition,
          template_id: mode === "template" ? selectedTemplate?.id ?? null : null,
        });
        rId = created.radar.id;
        setDraftRadarId(rId);
        onRadarChanged?.();
      } else if (!editRadar || editRadar.radar.status === "draft") {
        await api.radarUpdate({ id: rId, ...draftDefinition });
        onRadarChanged?.();
      }
      setRequiresVersionConfirm(Boolean(editRadar));

      const started = await api.radarPreviewStart({
        radar_id: rId,
        description,
        user_profession: userProfession.trim() || null,
        fields: activeFields,
        match_policy: plan.matchPolicy,
        source_ids: plan.sourceIds,
      });
      activePreviewId.current = started.preview_id;
      setPreviewState(started);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      startingPreview.current = false;
      setPreviewLoading(false);
    }
  };

  useEffect(() => {
    if (initialStep !== 4 || !editRadar || !version) return;
    if (!selectedSourceIds.length) {
      setStep(1);
      setSourcesOpen(true);
      return;
    }
    const savedSignature = JSON.stringify([
      version.description, version.user_profession ?? "", version.fields,
      version.match_policy.want_intent, version.match_policy.exclude_roles.includes("peer"),
      version.match_policy.hard_filters, version.match_policy.condition ?? null, editRadar.radar.source_ids,
    ]);
    if (editRadar.radar.status !== "draft" || savedSignature !== definitionSignature) {
      void startPreviewRun();
      return;
    }
    let disposed = false;
    setPreviewLoading(true);
    void api.radarPreviewGet(editRadar.radar.id).catch(() => null).then((snapshot) => {
      if (disposed) return;
      const sameSources = snapshot?.source_ids?.length === selectedSourceIds.length
        && selectedSourceIds.every((id) => snapshot.source_ids?.includes(id));
      if (snapshot && snapshot.radar_version === version.version && sameSources) {
        evaluatedSignature.current = savedSignature;
        activePreviewId.current = snapshot.preview_id;
        attachedPreview.current = true;
        setPreviewState(snapshot);
        setPreviewLoading(false);
      } else {
        void startPreviewRun();
      }
    });
    return () => { disposed = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const preparePreview = async () => {
    if (preparing.current || suggesting || previewBusy || saving) return;
    if (!description.trim()) {
      setErrorMsg("Hãy mô tả điều bạn muốn tìm.");
      return;
    }
    preparing.current = true;
    try {
      const needsFields = !fields.length || (!editRadar && mode === "blank"
        && analyzedDescription !== null && analyzedDescription !== descriptionKey);
      const needsSources = !sourcesManual && (!selectedSourceIds.length || analyzedDescription !== descriptionKey);
      const plan = needsFields || needsSources ? await runSuggestFields(needsFields) : getPreviewPlan();
      if (!plan) return;
      if (!plan.fields.length) {
        setErrorMsg("Cần ít nhất một thông tin để Radar trích xuất.");
        return;
      }
      if (plan.matchPolicy.hard_filters.some(filter =>
        !plan.fields.some(field => field.key === filter.field) ||
        (filter.op !== "is_empty" && (filter.value == null || filter.value === "")))) {
        setErrorMsg("Hãy kiểm tra các điều kiện bắt buộc và điền giá trị còn thiếu trước khi chạy thử.");
        return;
      }
      if (!plan.sourceIds.length) {
        setSourcesOpen(true);
        setErrorMsg(sourcesManual
          ? "Hãy chọn ít nhất một nhóm để chạy xem thử."
          : "AI chưa tìm thấy nhóm phù hợp. Bạn có thể chọn nguồn bên dưới hoặc mở nhóm trên Facebook rồi làm mới danh sách.");
        return;
      }
      setStep(4);
      await startPreviewRun(undefined, plan);
    } finally {
      preparing.current = false;
    }
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
    const removedKey = fields[idx]?.key;
    setFields((prev) => prev.filter((_, i) => i !== idx).map((f, i) => ({ ...f, order: i + 1 })));
    setHardFilters(filters => filters.filter(filter => filter.field !== removedKey));
  };

  const toggleSource = (id: string) => {
    setSourcesManual(true);
    setSourcesSuggested(false);
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
    setMissedPostIds((ids) => label === "missed"
      ? (ids.includes(item.post_id) ? ids : [...ids, item.post_id])
      : ids.filter((id) => id !== item.post_id));
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
    if (activate && health && (health.automatic_scanning!==true || !health.extension_connected || health.facebook_session !== "ok" || health.crawl_paused) && !readyAck) {setErrorMsg("Xác nhận chế độ hoạt động giới hạn trước khi bật radar.");return;}
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
      let previousVersion: number | null = null;
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
        previousVersion=latest.radar.current_version;
        const versionToSave = latest.pending_version_data ?? latest.current_version_data;
        const same = versionToSave.description === description
          && JSON.stringify(versionToSave.fields) === JSON.stringify(normalizedFields)
          && JSON.stringify(versionToSave.match_policy) === JSON.stringify(currentMatchPolicy())
          && versionToSave.user_profession === (userProfession.trim() || null);
        await api.radarUpdate({id:rId,name:radarName.trim()||"Radar mới",source_ids:selectedSourceIds,notify,
          ...(same && activate ? {} : {description,user_profession:userProfession.trim()||null,fields:normalizedFields,match_policy:currentMatchPolicy()}),
          confirm_version_upgrade:activate,
        });
      }

      if (activate) {
        await api.radarSetStatus(rId, "active", previewState?.preview_id);
        await offerSaveUndo(rId, previousVersion);
      }
      saveWorkspace(draftKey,null);
      onSaved(rId);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  /** Sau khi lưu bản mới, cho phép quay lại đúng bản trước đó chỉ bằng một nút "Hoàn tác". */
  const offerSaveUndo = async (radarId: string, previousVersion: number | null) => {
    if (previousVersion === null) return;
    try {
      const after = await api.radarGet(radarId);
      if (after.radar.current_version === previousVersion) return;
      offerUndo("Đã lưu radar", async () => {
        const latest = await api.radarGet(radarId);
        await api.workspaceAction("rollback", { radar_id: radarId, version: previousVersion, expected_version: latest.radar.current_version });
        onRadarChanged?.();
      });
    } catch {
      // Hoàn tác chỉ là tiện ích thêm; lưu đã thành công nên không báo lỗi.
    }
  };

  const goalTemplateId = /bán xe|bán ô tô/i.test(initialGoal) ? "xe-cu.duoi-gia"
    : /cần thợ|tìm thợ/i.test(initialGoal) ? "dich-vu.tim-tho"
    : /cần thuê căn hộ|tìm thuê căn hộ/i.test(initialGoal) ? "bds.khach-thue" : null;
  const goalTemplate = templates.find(template => template.id === goalTemplateId);

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

  useEffect(() => {
    const labelled = (previewState?.items ?? []).filter((i) => i.feedback_label === "missed").map((i) => i.post_id);
    if (labelled.length) setMissedPostIds((ids) => [...new Set([...ids, ...labelled])]);
  }, [previewState]);

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
    condition,
    setCondition,
    missedPostIds,
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
    attachedPreview: attachedPreview.current,
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
    goalTemplate,
    startBlank,
    handlePlaceholderChange,
    runSuggestFields,
    sourcesOpen,
    setSourcesOpen,
    sourcesSuggested,
    stopPreview,
    currentMatchPolicy,
    startPreviewRun,
    preparePreview,
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
