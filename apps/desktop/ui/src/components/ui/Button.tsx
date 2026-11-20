import type { ButtonHTMLAttributes } from "react";
import { cx } from "./cx";

export type ButtonVariant = "default" | "primary" | "danger" | "success";
export type ButtonSize = "md" | "sm";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
}

/** Base button. Defaults to `type="button"` so it never submits an enclosing form by accident. */
export function Button({
  variant = "default",
  size = "md",
  block = false,
  type = "button",
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        "btn",
        variant !== "default" && `btn-${variant}`,
        size === "sm" && "btn-sm",
        block && "btn-block",
        className
      )}
      {...rest}
    />
  );
}
