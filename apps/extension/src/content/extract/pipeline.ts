// Combined multi-strategy extraction pipeline.

import type { ExtractorProfile, RawPost, ExtractionStrategy } from "../../protocol";
import { extractFromDom } from "./dom";
import { extractFromEmbedded, extractFromNetwork, mergeRawPosts } from "./network";
import { DEFAULT_EXTRACTOR_PROFILE } from "./profile";

// ── Combined Multi-Strategy Pipeline (`02-extension.md §4`) ──

export type ExtractionPipelineInput = {
  networkPayloads: readonly string[];
  doc: Document;
  sourceExternalId: string;
  profile?: ExtractorProfile;
  capturedAt?: number;
};

export type ExtractionPipelineOutput = {
  posts: RawPost[];
  primaryStrategy: ExtractionStrategy;
};

export function runExtractionPipeline(
  input: ExtractionPipelineInput,
): ExtractionPipelineOutput {
  const profile = input.profile ?? DEFAULT_EXTRACTOR_PROFILE;
  const capturedAt = input.capturedAt ?? Date.now();
  const strategies: ExtractionStrategy[] =
    Array.isArray(profile.strategies) && profile.strategies.length > 0
      ? profile.strategies
      : DEFAULT_EXTRACTOR_PROFILE.strategies;

  const byId = new Map<string, RawPost>();
  let primaryStrategy: ExtractionStrategy = strategies[0] ?? "network";
  let primaryStrategySet = false;

  for (const strategy of strategies) {
    if (strategy === "network") {
      const posts = extractFromNetwork(
        input.networkPayloads,
        input.sourceExternalId,
        profile,
        capturedAt,
      );
      if (posts.length > 0 && !primaryStrategySet) {
        primaryStrategy = "network";
        primaryStrategySet = true;
      }
      for (const p of posts) {
        const existing = byId.get(p.post_id);
        byId.set(p.post_id, existing ? mergeRawPosts(existing, p) : p);
      }
    } else if (strategy === "embedded") {
      const posts = extractFromEmbedded(
        input.doc,
        input.sourceExternalId,
        profile,
        capturedAt,
      );
      if (posts.length > 0 && !primaryStrategySet) {
        primaryStrategy = "embedded";
        primaryStrategySet = true;
      }
      for (const p of posts) {
        const existing = byId.get(p.post_id);
        byId.set(p.post_id, existing ? mergeRawPosts(existing, p) : p);
      }
    } else if (strategy === "dom") {
      // `dom` is fallback: run when earlier strategies yielded 0 posts, or when `dom` is first
      if (byId.size === 0) {
        const posts = extractFromDom(
          input.doc,
          input.sourceExternalId,
          profile,
          capturedAt,
        );
        if (posts.length > 0 && !primaryStrategySet) {
          primaryStrategy = "dom";
          primaryStrategySet = true;
        }
        for (const p of posts) {
          if (!byId.has(p.post_id)) {
            byId.set(p.post_id, p);
          }
        }
      }
    }
  }

  return {
    posts: Array.from(byId.values()),
    primaryStrategy,
  };
}
