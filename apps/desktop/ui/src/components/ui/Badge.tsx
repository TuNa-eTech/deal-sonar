import type { HTMLAttributes } from "react";
import { cx } from "./cx";

export type BadgeTone = "neutral" | "primary" | "success" | "warning" | "danger";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ tone = "neutral", className, ...rest }: BadgeProps) {
  return <span className={cx("badge", tone !== "neutral" && `badge-${tone}`, className)} {...rest} />;
}
