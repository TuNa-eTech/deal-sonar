import React from "react";
import { formatAge, formatExactTime, leadFreshness } from "../lib/format";

/** How old a lead is, coloured against its radar's lifetime rather than a fixed clock. */
export function AgeChip({ postedAt, expiresAt }: { postedAt: number | null | undefined; expiresAt?: number | null }) {
  const tone = leadFreshness(postedAt, expiresAt);
  const title = expiresAt
    ? `Đăng ${formatExactTime(postedAt)} · ${tone === "expired" ? "đã quá hạn từ" : "hết hạn"} ${formatExactTime(expiresAt)}`
    : formatExactTime(postedAt);
  return (
    <span className={`age-chip ${tone}`} title={title}>
      {tone === "expired" ? "quá hạn" : formatAge(postedAt)}
    </span>
  );
}
