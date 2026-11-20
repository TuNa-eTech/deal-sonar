// Shared harness for the catalog handler tests: a real in-memory SQLite `Store` behind a
// `RuntimeContext`, plus small row builders. No mocks of the code under test.

import { type RuntimeContext, Store, foldVi } from "../src";
import { type CatalogServices, createCatalogHandlers } from "../src/services/catalog";

export interface Harness {
  store: Store;
  ctx: RuntimeContext;
  events: Array<{ event: string; payload: any }>;
  setShuttingDown(value: boolean): void;
  /** Invoke a handler exactly like `DesktopRuntime.invoke`. */
  call(command: string, args?: Record<string, unknown>): Promise<any>;
}

export function harness(overrides: Partial<CatalogServices> = {}): Harness {
  const store = Store.openInMemory();
  const events: Array<{ event: string; payload: any }> = [];
  let shuttingDown = false;
  const ctx: RuntimeContext = {
    config: {} as RuntimeContext["config"],
    store,
    secrets: {} as RuntimeContext["secrets"],
    emit: (event, payload) => {
      events.push({ event, payload });
    },
    notifyOs: () => undefined,
    isShuttingDown: () => shuttingDown,
  };
  const handlers = createCatalogHandlers(overrides);
  return {
    store,
    ctx,
    events,
    setShuttingDown: (value) => {
      shuttingDown = value;
    },
    async call(command, args = {}) {
      const handler = handlers[command];
      if (!handler) throw new Error(`no handler for ${command}`);
      return handler(ctx, args);
    },
  };
}

export function addSource(store: Store, name: string, externalId: string, follow = false): string {
  const result = store.sources.upsertDiscovered(
    [{ external_id: externalId, name, url: `https://facebook.com/groups/${externalId}` }],
    follow,
    null,
    Date.now(),
  );
  return result.source_ids[0];
}

export function addPost(
  store: Store,
  sourceId: string,
  externalId: string,
  text: string,
  capturedAt: number,
  author: { external_id: string; name: string } | null = { external_id: `a-${externalId}`, name: `Author ${externalId}` },
) {
  const [post] = store.posts.insert({
    platform: "facebook",
    external_id: externalId,
    source_id: sourceId,
    author,
    permalink: `https://facebook.com/posts/${externalId}`,
    text,
    text_norm: text,
    text_fold: foldVi(text),
    content_hash: `hash-${externalId}`,
    simhash: 0n,
    created_at: capturedAt - 1_000,
    captured_at: capturedAt,
    strategy: "dom",
  });
  return post;
}

export interface World {
  sourceId: string;
  radarId: string;
  versionId: string;
  postId: string;
  evaluationId: string;
  leadId: string;
}

/** One group, one draft radar (`price` number + `phone` fields), and one matched lead. */
export async function leadWorld(h: Harness): Promise<World> {
  const sourceId = addSource(h.store, "Hà Nội Thuê Nhà", "g1", true);
  const detail = await h.call("radar_create_draft", {
    input: {
      name: "Khách thuê",
      description: "Người cần thuê nhà",
      fields: [
        { key: "price", label: "Giá", type: "number" },
        { key: "phone", label: "SĐT", type: "phone" },
      ],
      source_ids: [sourceId],
    },
  });
  const radarId: string = detail.radar.id;
  const versionId: string = detail.current_version_data.id;
  const now = Date.now();
  const post = addPost(h.store, sourceId, "p1", "Cần thuê căn hộ 2 phòng ngủ", now);
  const { evaluationId, leadId } = addLead(h.store, radarId, versionId, post.id, 0.9);
  return { sourceId, radarId, versionId, postId: post.id, evaluationId, leadId };
}

export function addLead(
  store: Store,
  radarId: string,
  versionId: string,
  postId: string,
  score: number,
  extra: { decidedBy?: string; rulesetId?: string | null } = {},
): { evaluationId: string; leadId: string } {
  const now = Date.now();
  const evaluation = store.leads.upsertEvaluation({
    post_id: postId,
    radar_version_id: versionId,
    state: "done",
    decided_by: extra.decidedBy ?? "ai",
    verdict: "match",
    score,
    intent: "demand",
    author_role: "end_user",
    summary: "Cần thuê",
    reason: "Khách cần thuê",
    ruleset_id: extra.rulesetId ?? null,
    created_at: now,
    decided_at: now,
  });
  const [lead] = store.leads.createLead({
    radar_id: radarId,
    radar_version_id: versionId,
    post_id: postId,
    evaluation_id: evaluation.id,
    score,
    summary: "Cần thuê căn hộ",
    fields: { price: { value: 10, raw: "10tr", confidence: 0.9, source: "ai" } },
    now_ms: now,
  });
  return { evaluationId: evaluation.id, leadId: lead.id };
}
