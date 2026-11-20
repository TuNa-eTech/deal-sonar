import type { HTMLAttributes } from "react";
import { cx } from "./cx";

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("card", className)} {...rest} />;
}
