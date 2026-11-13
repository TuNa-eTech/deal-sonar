import fs from "node:fs";
import path from "node:path";
import React, { act } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { injectMockLead } from "../lib/mockBackend";
import {
  escapeCsvCell,
  isSafeFacebookPermalink,
  openFacebookPermalink,
  renderHighlightedPostText,
} from "../lib/security";
import type { Lead } from "../types/ipc";

function collectAllSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "test") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectAllSourceFiles(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

describe("XSS & Link Security (`03-risks-compliance.md §4`)", () => {
  it("never uses dangerouslySetInnerHTML anywhere in UI source files", () => {
    const srcRoot = path.resolve(__dirname, "..");
    const files = collectAllSourceFiles(srcRoot);
    expect(files.length).toBeGreaterThan(10);

    const dangerousProp = ["dangerously", "SetInnerHTML"].join("");
    for (const file of files) {
      const content = fs.readFileSync(file, "utf-8");
      expect(content).not.toContain(dangerousProp);
    }
  });

  it("renders <img src=x onerror=alert(1)> and inline URLs strictly as inert plain text with mark highlights", () => {
    const xssPost =
      'Cần thuê căn hộ <img src=x onerror=alert(1)> tầm 12tr/th tại https://evil.example/phish <script>window.__pwn=true</script>';

    const { container } = render(
      <div className="post-plain-text">
        {renderHighlightedPostText(xssPost, [
          { raw: "<img src=x onerror=alert(1)>", fieldLabel: "Mô tả" },
          { raw: "tầm 12tr/th", fieldLabel: "Giá" },
        ])}
      </div>
    );

    expect(container.textContent).toBe(xssPost);
    expect(container.querySelectorAll("img, script, iframe, a").length).toBe(0);

    // Ensure zero DOM elements carry executable event handler attributes
    const allElements = Array.from(container.querySelectorAll("*"));
    for (const el of allElements) {
      for (const attr of el.getAttributeNames()) {
        expect(attr.toLowerCase().startsWith("on")).toBe(false);
      }
    }

    const marks = container.querySelectorAll("mark.evidence-mark");
    expect(marks.length).toBe(2);
    expect(marks[0]?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(marks[1]?.textContent).toBe("tầm 12tr/th");
  });

  it("validates Facebook permalinks strictly and blocks malicious non-Facebook URLs in Lead Detail", async () => {
    expect(
      isSafeFacebookPermalink("https://www.facebook.com/groups/12345/posts/67890/")
    ).toBe(true);
    expect(
      isSafeFacebookPermalink("https://m.facebook.com/groups/12345/permalink/67890/")
    ).toBe(true);
    expect(
      isSafeFacebookPermalink("https://web.facebook.com/groups/12345/posts/67890/")
    ).toBe(true);

    // Malicious / spoofed URLs must fail
    expect(isSafeFacebookPermalink("javascript:alert(1)")).toBe(false);
    expect(isSafeFacebookPermalink("http://www.facebook.com/groups/123/")).toBe(false);
    expect(
      isSafeFacebookPermalink("https://www.facebook.com.evil.example/groups/123/")
    ).toBe(false);
    expect(
      isSafeFacebookPermalink("https://user:pass@www.facebook.com/groups/123/")
    ).toBe(false);
    expect(openFacebookPermalink("https://evil.example/steal").opened).toBe(false);

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const user = userEvent.setup();

    render(<App />);
    await screen.findByRole("heading", { name: "Cơ hội" });

    const maliciousLead: Lead = {
      id: "01JCF7XSS00000000000000099",
      radar_id: "01JCF300000000000000000001",
      radar_name: "Khách thuê căn hộ Cầu Giấy",
      radar_version_id: "01JCF400000000000000000001",
      radar_version: 1,
      post_id: "01JCF6XSS00000000000000099",
      evaluation_id: "01JCF8XSS00000000000000099",
      contact_id: null,
      status: "new",
      score: 0.91,
      is_weak_match: false,
      summary: "Bài kiểm thử bảo mật <img src=x onerror=alert(1)>",
      reason: "Test XSS",
      decided_by: "ai",
      fields: {
        location: {
          value: { raw: "Cầu Giấy", province: "Hà Nội", district: "Cầu Giấy", ward: null },
          raw: "Cầu Giấy",
          confidence: 0.95,
          source: "ai",
        },
      },
      source_id: "01JCF100000000000000000001",
      source_name: "Group <script>alert(1)</script>",
      author_id: "attacker-1",
      author_name: 'Attacker"><img src=x onerror=alert(1)>',
      permalink: "https://www.facebook.com.attacker.test/groups/phish",
      post_created_at: Date.now(),
      also_seen_in: [],
      notified_at: null,
      follow_up_at: null,
      note: null,
      tags: [],
      feedback_label: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    await act(async () => {
      injectMockLead(
        maliciousLead,
        "Cần thuê nhà Cầu Giấy <img src=x onerror=alert(1)> bấm vào https://phish.test/login"
      );
    });

    const listPane = document.querySelector(".lead-list-pane") as HTMLElement;
    const maliciousRowText = await within(listPane).findByText(/Bài kiểm thử bảo mật/);
    await user.click(maliciousRowText);

    await waitFor(() => {
      const postBox = screen.getByTestId("lead-post-plaintext");
      expect(postBox.textContent).toContain("<img src=x onerror=alert(1)>");
      expect(postBox.querySelectorAll("img, script, a").length).toBe(0);
    });

    const openBtn = screen.getByRole("button", { name: /Mở trên Facebook/i });
    await user.click(openBtn);

    expect(openSpy).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/Đã chặn mở liên kết/i);
    });

    openSpy.mockRestore();
  });

  it("guards CSV export cells against formula injection (`07-notifications-export.md §5`)", () => {
    expect(escapeCsvCell("=CMD|' /C calc'!A0")).toBe("'=CMD|' /C calc'!A0");
    expect(escapeCsvCell("+84912345678")).toBe("'+84912345678");
    expect(escapeCsvCell("-15tr")).toBe("'-15tr");
    expect(escapeCsvCell("@admin")).toBe("'@admin");
    expect(escapeCsvCell("Cầu Giấy, Hà Nội")).toBe('"Cầu Giấy, Hà Nội"');
  });
});
