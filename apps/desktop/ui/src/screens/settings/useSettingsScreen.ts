// Settings draft state, persistence, and derived AI model options.

import { useEffect, useRef, useState } from "react";
import { readWorkspace, saveWorkspace } from "../../lib/workspace";
import { api } from "../../lib/api";
import type { AiModelOption, AiProviderId, Channel, LicenseStatus, ProbeResult, Settings } from "../../types/ipc";
import { FALLBACK_MODELS_BY_PROVIDER } from "./constants";

export interface SettingsScreenProps {
  settings: Settings;
  license: LicenseStatus;
  onSettingsUpdated: (s: Settings) => void;
  onLicenseUpdated: (l: LicenseStatus) => void;
  onReopenOnboarding: () => void;
  onAllDataDeleted: () => void;
}

export function useSettingsScreen({
  settings,
  license,
  onSettingsUpdated,
  onLicenseUpdated,
  onReopenOnboarding,
  onAllDataDeleted,
}: SettingsScreenProps) {
  const [draft, setDraft] = useState<Settings>(()=>({...settings,...readWorkspace<Partial<Settings>>("settings-draft",{})}));
  const baseline = useRef(settings);
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useState("ai");
  const mergeSettings = (next:Settings, savedKeys:string[]=[]) => {
    const before=baseline.current;
    setDraft(current=>Object.fromEntries(Object.entries(next).map(([key,value])=>[key, savedKeys.includes(key)||JSON.stringify(current[key as keyof Settings])===JSON.stringify(before[key as keyof Settings])?value:current[key as keyof Settings]])) as unknown as Settings);
    baseline.current=next;
  };
  const dirtyKeys=(Object.keys(draft) as (keyof Settings)[]).filter(k=>JSON.stringify(draft[k])!==JSON.stringify(settings[k]));
  useEffect(()=>{saveWorkspace("settings-draft",Object.fromEntries(dirtyKeys.map(k=>[k,draft[k]])));},[draft,settings]);
  const [probes, setProbes] = useState<Record<AiProviderId, ProbeResult> | null>(null);
  const [probingAi, setProbingAi] = useState(false);
  const [customFastMode, setCustomFastMode] = useState(false);
  const [customSmartMode, setCustomSmartMode] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);

  const [tgToken, setTgToken] = useState("");
  const [whName, setWhName] = useState("");
  const [whUrl, setWhUrl] = useState("");
  const [whSecret, setWhSecret] = useState("");
  const [whPrivacyAck, setWhPrivacyAck] = useState(false);

  const [licenseInput, setLicenseInput] = useState("");
  const [deleteStep, setDeleteStep] = useState<0 | 1 | 2>(0);
  const [deletePhrase, setDeletePhrase] = useState("");

  const [banner, setBanner] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    mergeSettings(settings);
  }, [settings]);

  const loadAux = async () => {
    setProbingAi(true);
    try {
      const [p, ch, refreshedSettings] = await Promise.all([
        api.aiProbe(),
        api.channelList(),
        api.settingsGet(),
      ]);
      setProbes(p);
      setChannels(ch);
      mergeSettings(refreshedSettings);
      onSettingsUpdated(refreshedSettings);
    } finally {
      setProbingAi(false);
    }
  };

  useEffect(() => {
    void loadAux();
  }, []);

  const savePatch = async (patch: Partial<Settings>, msg = "Đã lưu thay đổi cài đặt.") => {
    if (saving) return;
    setSaving(true);
    try {
      const updated = await api.settingsSet(patch);
      mergeSettings(updated, Object.keys(patch));
      onSettingsUpdated(updated);
      setBanner({ kind: "ok", text: msg });
    } catch (err) {
      setBanner({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    } finally { setSaving(false); }
  };

  const activeProvider: AiProviderId = draft.ai_provider ?? "claude_cli";
  const tierMap = draft.model_tiers[activeProvider];
  const activeProbe = probes?.[activeProvider];
  const availableModels: AiModelOption[] =
    activeProbe?.available_models && activeProbe.available_models.length > 0
      ? activeProbe.available_models
      : FALLBACK_MODELS_BY_PROVIDER[activeProvider];
  const hasScannedLocalModels = availableModels.some((m) => m.source === "local_cli");

  const fastInCatalog = availableModels.some((m) => m.id === tierMap.fast);
  const smartInCatalog = availableModels.some((m) => m.id === tierMap.smart);
  const showCustomFastInput = customFastMode || !fastInCatalog;
  const showCustomSmartInput = customSmartMode || !smartInCatalog;

  const fastRecommendedOptions = availableModels.filter((m) => m.recommended_tier === "fast");
  const fastOtherOptions = availableModels.filter((m) => m.recommended_tier !== "fast");
  const smartRecommendedOptions = availableModels.filter((m) => m.recommended_tier === "smart");
  const smartOtherOptions = availableModels.filter((m) => m.recommended_tier !== "smart");

  return {
    settings,
    license,
    onSettingsUpdated,
    onLicenseUpdated,
    onReopenOnboarding,
    onAllDataDeleted,
    draft,
    setDraft,
    baseline,
    saving,
    setSaving,
    section,
    setSection,
    mergeSettings,
    dirtyKeys,
    probes,
    setProbes,
    probingAi,
    setProbingAi,
    customFastMode,
    setCustomFastMode,
    customSmartMode,
    setCustomSmartMode,
    channels,
    setChannels,
    tgToken,
    setTgToken,
    whName,
    setWhName,
    whUrl,
    setWhUrl,
    whSecret,
    setWhSecret,
    whPrivacyAck,
    setWhPrivacyAck,
    licenseInput,
    setLicenseInput,
    deleteStep,
    setDeleteStep,
    deletePhrase,
    setDeletePhrase,
    banner,
    setBanner,
    loadAux,
    savePatch,
    activeProvider,
    tierMap,
    activeProbe,
    availableModels,
    hasScannedLocalModels,
    fastInCatalog,
    smartInCatalog,
    showCustomFastInput,
    showCustomSmartInput,
    fastRecommendedOptions,
    fastOtherOptions,
    smartRecommendedOptions,
    smartOtherOptions,
  };
}

export type SettingsScreenModel = ReturnType<typeof useSettingsScreen>;
