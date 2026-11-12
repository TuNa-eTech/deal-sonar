import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  detectGroupInaccessible,
  detectSessionFromUrl,
  detectSessionStatus,
  driveCrawlInPage,
  expandSeeMoreButtons,
} from "../src/content/drive";
import {
  DEFAULT_EXTRACTOR_PROFILE,
  extractCurrentGroupInfo,
  extractFromDom,
  extractFromEmbedded,
  extractFromNetwork,
  extractJoinedGroups,
  runExtractionPipeline,
} from "../src/content/extract";
import type { ExtractorProfile } from "../src/protocol";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readFixture(name: string): string {
  return readFileSync(resolve(rootDir, "fixtures", name), "utf-8");
}

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("Extractors, Group Discovery, Session Detection & Safe Page Driver", () => {
  it("extracts posts from multi-line/NDJSON Facebook GraphQL payload (`network` strategy)", () => {
    const ndjson = readFixture("graphql-feed.ndjson");
    const capturedAt = 1794384900000;

    // Also verify empty `{}` sub-objects in desktop profile merge cleanly with defaults
    const desktopStyleProfile: ExtractorProfile = {
      rev: 4,
      strategies: ["network", "embedded", "dom"],
      network: {},
      dom: {},
      session_markers: {},
    };

    const posts = extractFromNetwork(
      [ndjson],
      "123456789",
      desktopStyleProfile,
      capturedAt,
    );

    // 2 valid posts; the 3rd empty skeleton Story is skipped
    expect(posts).toHaveLength(2);

    const p1 = posts.find((p) => p.post_id === "987654321")!;
    expect(p1).toBeDefined();
    expect(p1.source_external_id).toBe("123456789");
    expect(p1.text).toContain("cần tìm căn hộ 2PN khu vực Cầu Giấy");
    expect(p1.text_truncated).toBe(false);
    expect(p1.author).toEqual({
      external_id: "100099887766",
      name: "Nguyễn Văn Minh",
      is_anonymous: false,
    });
    // Seconds (1794384600) normalized to Unix ms (1794384600000)
    expect(p1.created_at).toBe(1794384600000);
    expect(p1.captured_at).toBe(capturedAt);
    expect(p1.permalink).toBe("https://www.facebook.com/groups/123456789/posts/987654321/");
    expect(p1.attachments).toEqual([
      {
        kind: "photo",
        url: "https://scontent.xx.fbcdn.net/v/sample-apt-1.jpg",
        alt: "Ảnh phòng khách chung cư 2 phòng ngủ",
      },
    ]);
    expect(p1.counts).toEqual({ comments: 7, reactions: 19 });
    expect(p1.extraction).toEqual({ strategy: "network", profile_rev: 4 });

    const p2 = posts.find((p) => p.post_id === "987654322")!;
    expect(p2).toBeDefined();
    expect(p2.author.is_anonymous).toBe(true);
    expect(p2.author.external_id).toBeUndefined();
    expect(p2.author.name).toBe("Thành viên ẩn danh");
    expect(p2.created_at).toBe(1794384750000);
    expect(p2.attachments[0]?.kind).toBe("link");
    expect(p2.counts).toEqual({ comments: 3, reactions: 5 });
  });

  it("extracts posts & current group metadata from `<script type=\"application/json\">` (`embedded` strategy)", () => {
    const doc = parseHtml(readFixture("embedded-feed.html"));
    const capturedAt = 1794385100000;

    const posts = extractFromEmbedded(
      doc,
      "555666777",
      DEFAULT_EXTRACTOR_PROFILE,
      capturedAt,
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]?.post_id).toBe("222333444");
    expect(posts[0]?.author.name).toBe("Phạm Thu Hà");
    expect(posts[0]?.created_at).toBe(1794385000000);
    expect(posts[0]?.extraction.strategy).toBe("embedded");

    const groupInfo = extractCurrentGroupInfo(
      doc,
      "https://www.facebook.com/groups/chonhadathanoi/",
    );
    expect(groupInfo).toEqual({
      platform: "facebook",
      kind: "group",
      external_id: "555666777",
      name: "Chợ Nhà Đất Chính Chủ Hà Nội",
      url: "https://www.facebook.com/groups/555666777/",
      privacy: "private",
      member_count: 48500,
    });
  });

  it("falls back to `dom` extractor when network/embedded return 0 posts, omitting unavailable `created_at` and ignoring nested comments", () => {
    const doc = parseHtml(readFixture("dom-feed.html"));
    const capturedAt = 1794386000000;

    // Direct DOM extraction before expanding "Xem thêm"
    const domPosts = extractFromDom(
      doc,
      "thosuadiennuoc",
      DEFAULT_EXTRACTOR_PROFILE,
      capturedAt,
    );

    // Must extract ONLY the 2 top-level posts, NOT the nested comment `[role="article"]`!
    expect(domPosts).toHaveLength(2);

    const first = domPosts.find((p) => p.post_id === "333444555")!;
    expect(first).toBeDefined();
    expect(first.author).toEqual({
      external_id: "100077788899",
      name: "Lê Hoàng Nam",
      is_anonymous: false,
    });
    expect(first.text_truncated).toBe(true);
    expect("created_at" in first).toBe(false);
    expect(first.extraction.strategy).toBe("dom");

    const second = domPosts.find((p) => p.post_id === "333444556")!;
    expect(second).toBeDefined();
    expect(second.author).toEqual({
      name: "Thành viên ẩn danh",
      is_anonymous: true,
    });
    expect(second.text_truncated).toBe(false);
    // Emoji 16x16 filtered out; only real photo kept
    expect(second.attachments).toEqual([
      {
        kind: "photo",
        url: "https://scontent.xx.fbcdn.net/v/ac-unit-wall.jpg",
        alt: "Vị trí tường cần lắp máy lạnh",
      },
    ]);

    // Pipeline fallback verification
    const pipelineOut = runExtractionPipeline({
      networkPayloads: [],
      doc,
      sourceExternalId: "thosuadiennuoc",
      profile: DEFAULT_EXTRACTOR_PROFILE,
      capturedAt,
    });
    expect(pipelineOut.primaryStrategy).toBe("dom");
    expect(pipelineOut.posts).toHaveLength(2);
  });

  it("discovers joined groups on `/groups/joins` while skipping navigation links", () => {
    const doc = parseHtml(readFixture("joined-groups.html"));
    const groups = extractJoinedGroups(
      doc,
      "https://www.facebook.com/groups/joins/",
    );

    expect(groups).toHaveLength(3);
    expect(groups.find((g) => g.external_id === "thuechungcuhanoi")).toEqual({
      platform: "facebook",
      kind: "group",
      external_id: "thuechungcuhanoi",
      name: "Thuê Chung Cư Hà Nội Chính Chủ",
      url: "https://www.facebook.com/groups/thuechungcuhanoi/",
      privacy: "private",
      member_count: 125400,
    });

    const carGroup = groups.find((g) => g.name.includes("Xe Cũ"));
    expect(carGroup?.privacy).toBe("public");
    expect(carGroup?.member_count).toBe(1_200_000);

    const truckGroup = groups.find((g) => g.external_id === "888999000");
    expect(truckGroup?.privacy).toBe("private");
    expect(truckGroup?.member_count).toBe(14_500);
  });

  it("detects `ok`, `logged_out`, `checkpoint`, `rate_limited`, and inaccessible groups accurately without post-text spoofing", () => {
    const loginDoc = parseHtml(readFixture("session-login.html"));
    expect(
      detectSessionStatus(loginDoc, "https://www.facebook.com/groups/123/").state,
    ).toBe("logged_out");
    expect(
      detectSessionFromUrl("https://www.facebook.com/login.php?next=...")?.state,
    ).toBe("logged_out");

    const cpDoc = parseHtml(readFixture("session-checkpoint.html"));
    expect(
      detectSessionStatus(cpDoc, "https://www.facebook.com/groups/123/").state,
    ).toBe("checkpoint");
    expect(
      detectSessionFromUrl("https://www.facebook.com/checkpoint/1501092823525282/")?.state,
    ).toBe("checkpoint");

    const rlDoc = parseHtml(readFixture("session-ratelimited.html"));
    expect(
      detectSessionStatus(rlDoc, "https://www.facebook.com/groups/123/").state,
    ).toBe("rate_limited");

    // Normal feed with a user post mentioning "bạn tạm thời bị chặn" MUST stay `ok`
    const feedDoc = parseHtml(readFixture("dom-feed.html"));
    const msgEl = feedDoc.getElementById("msg-1")!;
    msgEl.append(" Hôm qua nick phụ hiện thông báo bạn tạm thời bị chặn.");
    expect(
      detectSessionStatus(
        feedDoc,
        "https://www.facebook.com/groups/thosuadiennuoc/",
      ).state,
    ).toBe("ok");

    // Inaccessible group check
    const unavailableDoc = parseHtml(
      `<html><body><div role="main"><h2>Nội dung này hiện không hiển thị</h2></div></body></html>`,
    );
    expect(
      detectGroupInaccessible(
        unavailableDoc,
        "https://www.facebook.com/groups/deleted_group/",
      ).inaccessible,
    ).toBe(true);
  });

  it("expands ONLY verified read-only `Xem thêm` post text buttons and NEVER clicks social/comment/join/link elements", () => {
    const doc = parseHtml(readFixture("dom-feed.html"));
    const clickedIds: string[] = [];

    const trackedIds = [
      "safe-see-more-1",
      "unsafe-header-join",
      "unsafe-external-link",
      "unsafe-like-btn",
      "unsafe-comment-btn",
      "unsafe-share-btn",
      "unsafe-comment-see-more",
    ];
    for (const id of trackedIds) {
      const el = doc.getElementById(id)!;
      el.addEventListener("click", (ev) => {
        ev.preventDefault();
        clickedIds.push(id);
        if (id === "safe-see-more-1") {
          const msg = doc.getElementById("msg-1")!;
          msg.textContent =
            "Nhà mình ở Quận 7 bị rò đường ống nước âm tường, cần thợ có máy dò qua kiểm tra gấp trong chiều nay. Liên hệ 0909.888.777.";
        }
      });
    }

    const expanded = expandSeeMoreButtons(doc, DEFAULT_EXTRACTOR_PROFILE);
    expect(expanded).toBe(1);
    expect(clickedIds).toEqual(["safe-see-more-1"]);

    // Subsequent extraction sees full un-truncated text
    const afterPosts = extractFromDom(doc, "thosuadiennuoc", DEFAULT_EXTRACTOR_PROFILE);
    const p1 = afterPosts.find((p) => p.post_id === "333444555")!;
    expect(p1.text_truncated).toBe(false);
    expect(p1.text).toContain("0909.888.777");
  });

  it("stops scrolling early in `driveCrawlInPage` when hitting `seen_post_ids` or `max_posts`", async () => {
    const doc = parseHtml(readFixture("embedded-feed.html"));
    const scrollSpy = vi.fn();
    const sleepSpy = vi.fn(async () => {});

    // Case 1: Post `222333444` is already in `seenPostIds` -> stops on step 0 without scrolling
    const result = await driveCrawlInPage({
      doc,
      win: window,
      sourceRef: { platform: "facebook", kind: "group", external_id: "555666777" },
      maxPosts: 30,
      maxScrollSteps: 3,
      seenPostIds: ["222333444"],
      extractor: DEFAULT_EXTRACTOR_PROFILE,
      getNetworkPayloads: () => [],
      scrollFn: scrollSpy,
      sleepFn: sleepSpy,
    });

    expect(result.status).toBe("ok");
    expect(result.posts).toHaveLength(1);
    expect(scrollSpy).toHaveBeenCalledTimes(0);
  });
});
