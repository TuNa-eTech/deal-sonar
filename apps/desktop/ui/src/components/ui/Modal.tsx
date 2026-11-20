import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export type ModalSize = "sm" | "md" | "lg";

export interface ModalProps {
  /** Accessible name of the dialog. */
  label: string;
  /** sm 520px, md 680px, lg 820px. Omit to use the panel's default width. */
  size?: ModalSize;
  /** Extra class on the panel, for screen-specific layout. */
  className?: string;
  children: ReactNode;
}

export function Modal({ label, size, className, children }: ModalProps) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={label}>
      <div className={cx("modal-panel", size && `modal-${size}`, className)}>{children}</div>
    </div>
  );
}

export function ModalHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("modal-header", className)} {...rest} />;
}

export function ModalBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("modal-body", className)} {...rest} />;
}

export function ModalFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("modal-footer", className)} {...rest} />;
}
