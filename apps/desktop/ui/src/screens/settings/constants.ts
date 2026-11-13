// Built-in model catalog used when the local CLI scan returns nothing.

import type { AiModelOption, AiProviderId } from "../../types/ipc";

export const FALLBACK_MODELS_BY_PROVIDER: Record<AiProviderId, AiModelOption[]> = {
  claude_cli: [
    {
      id: "haiku",
      label: "haiku — Claude Haiku mới nhất (Nhanh, tiết kiệm)",
      recommended_tier: "fast",
      source: "builtin",
    },
    {
      id: "sonnet",
      label: "sonnet — Claude Sonnet mới nhất (Cân bằng, thông minh)",
      recommended_tier: "smart",
      source: "builtin",
    },
    {
      id: "opus",
      label: "opus — Claude Opus mới nhất (Suy luận sâu)",
      recommended_tier: "smart",
      source: "builtin",
    },
    {
      id: "claude-haiku-4-5-20251001",
      label: "Claude Haiku 4.5 (claude-haiku-4-5-20251001)",
      recommended_tier: "fast",
      source: "builtin",
    },
    {
      id: "claude-sonnet-4-6",
      label: "Claude Sonnet 4.6 (claude-sonnet-4-6)",
      recommended_tier: "smart",
      source: "builtin",
    },
    {
      id: "claude-opus-4-6",
      label: "Claude Opus 4.6 (claude-opus-4-6)",
      recommended_tier: "smart",
      source: "builtin",
    },
  ],
  codex_cli: [
    {
      id: "gpt-6-luna",
      label: "GPT-6-Luna (gpt-6-luna) — Nhanh, tiết kiệm",
      recommended_tier: "fast",
      source: "builtin",
    },
    {
      id: "gpt-6.1-sol",
      label: "GPT-6.1-Sol (gpt-6.1-sol) — Suy luận & tạo bộ luật",
      recommended_tier: "smart",
      source: "builtin",
    },
    {
      id: "codex-mini-latest",
      label: "Codex Mini Latest (codex-mini-latest)",
      recommended_tier: "fast",
      source: "builtin",
    },
    {
      id: "gpt-5-codex",
      label: "GPT-5 Codex (gpt-5-codex)",
      recommended_tier: "smart",
      source: "builtin",
    },
  ],
  agy_cli: [
    {
      id: "gemini-3.8-flash-medium",
      label: "Gemini 3.8 Flash (Medium) (gemini-3.8-flash-medium)",
      recommended_tier: "fast",
      source: "builtin",
    },
    {
      id: "gemini-4-carbon-medium",
      label: "Gemini 4 Carbon (Medium) (gemini-4-carbon-medium)",
      recommended_tier: "smart",
      source: "builtin",
    },
    {
      id: "gemini-2.5-flash",
      label: "Gemini 2.5 Flash (gemini-2.5-flash)",
      recommended_tier: "fast",
      source: "builtin",
    },
    {
      id: "gemini-2.5-pro",
      label: "Gemini 2.5 Pro (gemini-2.5-pro)",
      recommended_tier: "smart",
      source: "builtin",
    },
  ],
};
