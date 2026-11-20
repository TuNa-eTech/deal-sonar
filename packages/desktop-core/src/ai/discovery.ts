// Port of crates/ai-bridge/src/adapters/discovery.rs: model discovery from each CLI's local
// caches (claude, codex), `agy models`, and built-in fallback catalogs.

import * as fs from "node:fs";
import * as path from "node:path";

import { type CliAdapterConfig, userHomeDir } from "./cli-util";
import { resolveBinaryInPath, runCliSubprocess } from "./subprocess";
import type { AiModelOption, ModelTier, ProviderId } from "./types";

type Json = unknown;
type JsonObject = Record<string, Json>;
const isObject = (v: Json): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: Json): string | null => (typeof v === "string" ? v : null);
const trimmedNonEmpty = (v: Json): string | null => {
  const s = str(v)?.trim();
  return s ? s : null;
};
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

function readJson(file: string): Json | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Json;
  } catch {
    return undefined;
  }
}

function pushUniqueModel(list: AiModelOption[], opt: AiModelOption): void {
  const trimmed = opt.id.trim();
  if (trimmed === "") return;
  if (!list.some((m) => m.id === trimmed)) list.push(opt);
}

const localCli = (id: string, label: string, tier: ModelTier): AiModelOption => ({
  id,
  label,
  recommended_tier: tier,
  source: "local_cli",
});
const builtin = (id: string, label: string, tier: ModelTier): AiModelOption => ({
  id,
  label,
  recommended_tier: tier,
  source: "builtin",
});

/**
 * Claude Code models from `~/.claude/cache/model-catalog/*.json`, `~/.claude/settings.json`,
 * the optional `--help` text, then the built-in catalog.
 */
export function discoverClaudeModels(cfg: CliAdapterConfig, helpText: string | null = null): AiModelOption[] {
  const models: AiModelOption[] = [];
  const home = userHomeDir(cfg);

  if (home) {
    const catalogDir = path.join(home, ".claude", "cache", "model-catalog");
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(catalogDir);
    } catch {
      entries = [];
    }
    const candidates: Array<{ isCc: boolean; fetchedAt: number; val: JsonObject }> = [];
    for (const name of entries) {
      if (path.extname(name) !== ".json") continue;
      const val = readJson(path.join(catalogDir, name));
      if (!isObject(val) || !isObject(val.catalog)) continue;
      const config = val.catalog.config;
      if (!isObject(config) || !Array.isArray(config.models)) continue;
      const fetched = typeof val.fetchedAt === "number" && Number.isInteger(val.fetchedAt) && val.fetchedAt >= 0 ? val.fetchedAt : 0;
      candidates.push({ isCc: val.catalog.surface === "cc", fetchedAt: fetched, val });
    }
    candidates.sort((a, b) => Number(b.isCc) - Number(a.isCc) || b.fetchedAt - a.fetchedAt);

    const best = candidates[0];
    const configObj = best && isObject(best.val.catalog) && isObject((best.val.catalog as JsonObject).config)
      ? ((best.val.catalog as JsonObject).config as JsonObject)
      : null;
    if (configObj) {
      if (isObject(configObj.provider_alias_targets)) {
        const aliases = configObj.provider_alias_targets;
        for (const alias of ["haiku", "sonnet", "opus", "fable"]) {
          const info = aliases[alias];
          if (info === undefined) continue;
          const targetDefault = isObject(info) ? (str(info.default) ?? "") : "";
          const tier: ModelTier = alias === "haiku" ? "fast" : "smart";
          const label =
            targetDefault === "" ? `${alias} — Bí danh tự động` : `${alias} — Bí danh tự động (${targetDefault})`;
          pushUniqueModel(models, localCli(alias, label, tier));
        }
      }
      if (Array.isArray(configObj.models)) {
        for (const item of configObj.models) {
          if (!isObject(item)) continue;
          const id = trimmedNonEmpty(item.id);
          if (!id) continue;
          const name = trimmedNonEmpty(item.name) ?? id;
          const shortName = str(item.short_name) ?? "";
          const desc = str(item.description)?.trim() ?? "";
          const combined = asciiLower(`${id} ${name} ${shortName} ${desc}`);
          const tier: ModelTier = combined.includes("haiku") || combined.includes("fast") ? "fast" : "smart";
          const label =
            desc !== "" ? `${name} (${id}) — ${desc}` : name.toLowerCase() !== id.toLowerCase() ? `${name} (${id})` : id;
          pushUniqueModel(models, localCli(id, label, tier));
        }
      }
    }

    const settings = readJson(path.join(home, ".claude", "settings.json"));
    if (isObject(settings)) {
      const m = trimmedNonEmpty(settings.model);
      if (m) {
        const tier: ModelTier = asciiLower(m).includes("haiku") ? "fast" : "smart";
        pushUniqueModel(models, localCli(m, `${m} (từ ~/.claude/settings.json)`, tier));
      }
    }
  }

  if (helpText !== null) {
    for (const alias of ["haiku", "sonnet", "opus", "fable"]) {
      if (helpText.includes(`'${alias}'`)) {
        pushUniqueModel(models, localCli(alias, `${alias} — Bí danh Claude (${alias})`, alias === "haiku" ? "fast" : "smart"));
      }
    }
  }

  if (models.length === 0) {
    for (const [id, label, tier] of [
      ["haiku", "haiku — Claude Haiku mới nhất (Nhanh, tiết kiệm)", "fast"],
      ["sonnet", "sonnet — Claude Sonnet mới nhất (Cân bằng, thông minh)", "smart"],
      ["opus", "opus — Claude Opus mới nhất (Suy luận sâu)", "smart"],
      ["claude-haiku-4-5-20251001", "Claude Haiku 4.5 (claude-haiku-4-5-20251001)", "fast"],
      ["claude-sonnet-4-6", "Claude Sonnet 4.6 (claude-sonnet-4-6)", "smart"],
      ["claude-opus-4-6", "Claude Opus 4.6 (claude-opus-4-6)", "smart"],
    ] as Array<[string, string, ModelTier]>) {
      pushUniqueModel(models, builtin(id, label, tier));
    }
  }
  return models;
}

/** Codex models from `~/.codex/models_cache.json`, `~/.codex/config.toml`, then built-ins. */
export function discoverCodexModels(cfg: CliAdapterConfig): AiModelOption[] {
  const models: AiModelOption[] = [];
  const home = userHomeDir(cfg);

  if (home) {
    const cache = readJson(path.join(home, ".codex", "models_cache.json"));
    if (isObject(cache) && Array.isArray(cache.models)) {
      const arr = cache.models;
      const hasListVis = arr.some((m) => isObject(m) && m.visibility === "list");
      for (const item of arr) {
        if (!isObject(item)) continue;
        const vis = str(item.visibility) ?? "list";
        if (hasListVis && vis !== "list") continue;
        if (!hasListVis && vis === "hide") continue;

        const slug = trimmedNonEmpty(item.slug ?? item.id ?? item.name);
        if (!slug) continue;
        const displayName = trimmedNonEmpty(item.display_name) ?? slug;
        const desc = str(item.description)?.trim() ?? "";
        const combined = asciiLower(`${slug} ${displayName} ${desc}`);
        const fast = ["mini", "luna", "fast", "flash", "nano", "efficient", "easier"].some((k) => combined.includes(k));
        const tier: ModelTier = fast ? "fast" : "smart";
        const same = displayName.toLowerCase() === slug.toLowerCase();
        const label =
          desc !== ""
            ? same
              ? `${slug} — ${desc}`
              : `${displayName} (${slug}) — ${desc}`
            : !same
              ? `${displayName} (${slug})`
              : slug;
        pushUniqueModel(models, localCli(slug, label, tier));
      }
    }

    try {
      const raw = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("[")) break;
        if (!trimmed.startsWith("model")) continue;
        const rest = trimmed.slice("model".length).trimStart();
        if (!rest.startsWith("=")) continue;
        const cleaned = rest
          .slice(1)
          .trim()
          .replace(/^"+|"+$/g, "")
          .replace(/^'+|'+$/g, "")
          .trim();
        if (cleaned === "") continue;
        const lc = asciiLower(cleaned);
        const tier: ModelTier = lc.includes("mini") || lc.includes("luna") ? "fast" : "smart";
        pushUniqueModel(models, localCli(cleaned, `${cleaned} (từ ~/.codex/config.toml)`, tier));
      }
    } catch {
      // no config.toml
    }
  }

  if (models.length === 0) {
    for (const [id, label, tier] of [
      ["codex-mini-latest", "Codex Mini Latest (codex-mini-latest) — Nhanh, tiết kiệm", "fast"],
      ["gpt-5-codex", "GPT-5 Codex (gpt-5-codex) — Suy luận & tạo bộ luật", "smart"],
      ["o4-mini", "o4-mini — Nhanh, suy luận gọn", "fast"],
    ] as Array<[string, string, ModelTier]>) {
      pushUniqueModel(models, builtin(id, label, tier));
    }
  }
  return models;
}

export function isValidAgyModelSlug(s: string): boolean {
  if (s.length < 3 || !/^[a-z]/.test(s)) return false;
  const hasSep = s.includes("-") || s.includes(".");
  return hasSep && /^[a-z0-9_.-]+$/.test(s);
}

/** Parse `agy models` stdout (carriage-return spinner frames included). */
export function parseAgyModelsStdout(stdout: string): AiModelOption[] {
  const models: AiModelOption[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const afterCr = (rawLine.split("\r").pop() ?? rawLine).trim();
    if (afterCr === "") continue;
    const parts = afterCr.split(/\s+/);
    const idTok = parts[0];
    if (!idTok || !isValidAgyModelSlug(idTok)) continue;
    const rest = parts.slice(1).join(" ");
    const combined = asciiLower(`${idTok} ${rest}`);
    const fast =
      combined.includes("flash") || idTok.endsWith("-low") || combined.includes("lite") || combined.includes("mini");
    const label = rest !== "" && rest.toLowerCase() !== idTok.toLowerCase() ? `${rest} (${idTok})` : idTok;
    pushUniqueModel(models, localCli(idTok, label, fast ? "fast" : "smart"));
  }
  return models;
}

/** `agy models` when supported, otherwise the built-in catalog. */
export async function discoverAgyModels(
  cfg: CliAdapterConfig,
  workdir: string,
  expandedPath: string,
  supportsModelsSubcommand: boolean,
): Promise<AiModelOption[]> {
  let models: AiModelOption[] = [];
  if (supportsModelsSubcommand && resolveBinaryInPath(cfg.binaryPath, expandedPath)) {
    try {
      const out = await runCliSubprocess(
        cfg.binaryPath,
        ["models"],
        null,
        workdir,
        expandedPath,
        cfg.extraEnv,
        Math.min(8_000, cfg.probeTimeoutMs),
      );
      if (out.exitCode === 0) models = parseAgyModelsStdout(out.stdout);
    } catch {
      // fall back to the built-in catalog
    }
  }
  if (models.length === 0) {
    for (const [id, label, tier] of [
      ["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium) (gemini-3.8-flash-medium)", "fast"],
      ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low) (gemini-3.8-flash-low)", "fast"],
      ["gemini-4-carbon-medium", "Gemini 4 Carbon (Medium) (gemini-4-carbon-medium)", "smart"],
      ["gemini-4-carbon-high", "Gemini 4 Carbon (High) (gemini-4-carbon-high)", "smart"],
      ["gemini-4-argon-medium", "Gemini 4 Argon (Medium) (gemini-4-argon-medium)", "smart"],
      ["claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking) (claude-sonnet-4-6)", "smart"],
      ["gemini-2.5-flash", "Gemini 2.5 Flash (gemini-2.5-flash)", "fast"],
      ["gemini-2.5-pro", "Gemini 2.5 Pro (gemini-2.5-pro)", "smart"],
    ] as Array<[string, string, ModelTier]>) {
      pushUniqueModel(models, builtin(id, label, tier));
    }
  }
  return models;
}

/** Best `(fast, smart)` model ids for a provider from a discovered list. */
export function recommendedModelsForProvider(
  provider: ProviderId,
  models: readonly AiModelOption[],
): [string | null, string | null] {
  const findPreferred = (prefs: string[], tier: ModelTier): string | null => {
    for (const p of prefs) {
      const found = models.find((m) => m.id === p);
      if (found) return found.id;
    }
    const byTier = models.find((m) => m.recommended_tier === tier) ?? models[0];
    return byTier ? byTier.id : null;
  };
  switch (provider) {
    case "claude_cli":
      return [
        findPreferred(["haiku", "claude-haiku-5-5", "claude-haiku-4-5-20251001"], "fast"),
        findPreferred(["sonnet", "claude-sonnet-5-5", "claude-sonnet-4-6"], "smart"),
      ];
    case "codex_cli":
      return [
        findPreferred(["gpt-6-luna", "codex-mini-latest", "o4-mini"], "fast"),
        findPreferred(["gpt-6.1-sol", "gpt-5-codex", "gpt-6-astra"], "smart"),
      ];
    case "agy_cli":
      return [
        findPreferred(["gemini-3.8-flash-medium", "gemini-3.8-flash-low", "gemini-2.5-flash"], "fast"),
        findPreferred(["gemini-4-carbon-medium", "gemini-4-argon-medium", "gemini-2.5-pro"], "smart"),
      ];
    default:
      return [findPreferred(["mock-fast-v1"], "fast"), findPreferred(["mock-smart-v1"], "smart")];
  }
}
