import type {
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { forwardRef } from "react";
import { cx } from "./cx";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cx("input", className)} {...rest} />;
  }
);

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx("select", className)} {...rest} />;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cx("textarea", className)} {...rest} />;
  }
);

export interface FieldProps {
  label: ReactNode;
  /** id of the control the label points at. */
  htmlFor?: string;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** Group of label, control and optional hint, matching `.field-group`. */
export function Field({ label, htmlFor, hint, className, children }: FieldProps) {
  return (
    <div className={cx("field-group", className)}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint != null && <FieldHint>{hint}</FieldHint>}
    </div>
  );
}

/** Secondary helper text under a control. Always a `div`, so it can hold inline markup. */
export function FieldHint({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("field-hint", className)} {...rest} />;
}
