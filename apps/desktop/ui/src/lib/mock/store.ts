// The live mock state plus test helpers that reset or inject data.

import type { PlanTier, HealthStatus, Lead, Post } from "../../types/ipc";
import { emitMockEvent } from "./events";
import { nextId } from "./ids";
import { buildPlanLimits, createInitialState, type MockCommandCall, type MockState } from "./seed";

export let state: MockState = createInitialState();

export function resetMockBackend(overrides?: {
  onboarding?: boolean;
  emptyRadars?: boolean;
  emptyLeads?: boolean;
  plan?: PlanTier;
}): void {
  state = createInitialState();
  if (overrides?.onboarding) {
    state.settings.privacy_consent_accepted = false;
    state.settings.onboarding_completed = false;
  }
  if (overrides?.emptyRadars) {
    state.radars = [];
    state.radarVersions = [];
    state.leads = [];
  }
  if (overrides?.emptyLeads) {
    state.leads = [];
  }
  if (overrides?.plan) {
    state.license.plan = overrides.plan;
    state.license.limits = buildPlanLimits(overrides.plan);
  }
}

export function setMockHealth(patch: Partial<HealthStatus>): HealthStatus {
  state.health = { ...state.health, ...patch, checked_at: Date.now() };
  emitMockEvent("health:changed", structuredClone(state.health));
  return structuredClone(state.health);
}

export function injectMockLead(lead: Lead, postText: string): void {
  const post: Post = {
    id: lead.post_id,
    platform: "facebook",
    external_id: lead.post_id,
    source_id: lead.source_id,
    source_name: lead.source_name,
    author_id: lead.author_id,
    author_name: lead.author_name,
    permalink: lead.permalink,
    text: postText,
    text_truncated: false,
    lang: "vi",
    created_at: lead.post_created_at,
    captured_at: lead.created_at,
    strategy: "network",
    purged_at: null,
  };
  state.posts.unshift(post);
  state.leads.unshift(lead);
  state.leadEvents[lead.id] = [
    {
      id: nextId("01JCFE"),
      lead_id: lead.id,
      kind: "created",
      data: { decided_by: lead.decided_by, radar_version: lead.radar_version },
      created_at: lead.created_at,
    },
  ];
  emitMockEvent("lead:new", structuredClone(lead));
}

export function getMockCommandCalls(): MockCommandCall[] {
  return structuredClone(state.calls);
}
