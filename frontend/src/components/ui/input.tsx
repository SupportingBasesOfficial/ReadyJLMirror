import { cn } from "@/lib/utils";
import { forwardRef } from "react";

// ── Label ────────────────────────────────────────────────────────────────────
export function Label({
  children,
  htmlFor,
  required,
  className,
}: { children: React.ReactNode; htmlFor?: string; required?: boolean; className?: string }) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn("block text-xs font-medium mb-1.5", className)}
      style={{ color: "var(--text-muted)" }}
    >
      {children}
      {required && <span className="ml-0.5" style={{ color: "var(--danger)" }}>*</span>}
    </label>
  );
}

// ── FieldError ───────────────────────────────────────────────────────────────
export function FieldError({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <p className="text-xs mt-1" style={{ color: "var(--danger)" }}>{children}</p>
  );
}

// ── FormGroup ────────────────────────────────────────────────────────────────
export function FormGroup({
  children,
  className,
}: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex flex-col", className)}>{children}</div>;
}

// ── Input ────────────────────────────────────────────────────────────────────
interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
  icon?: React.ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, error, icon, style, ...props }, ref) => (
    <div className="relative">
      {icon && (
        <span
          className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
          style={{ color: "var(--text-dim)" }}
        >
          {icon}
        </span>
      )}
      <input
        ref={ref}
        className={cn(className)}
        style={{
          ...(error ? { borderColor: "var(--danger)", boxShadow: "0 0 0 3px color-mix(in srgb, var(--danger) 15%, transparent)" } : {}),
          ...(icon ? { paddingLeft: 32 } : {}),
          ...style,
        }}
        {...props}
      />
    </div>
  ),
);
Input.displayName = "Input";

// ── Textarea ─────────────────────────────────────────────────────────────────
interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, error, style, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(className)}
      style={{
        ...(error ? { borderColor: "var(--danger)", boxShadow: "0 0 0 3px color-mix(in srgb, var(--danger) 15%, transparent)" } : {}),
        ...style,
      }}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

// ── Select ───────────────────────────────────────────────────────────────────
interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  error?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, error, style, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(className)}
      style={{
        ...(error ? { borderColor: "var(--danger)", boxShadow: "0 0 0 3px color-mix(in srgb, var(--danger) 15%, transparent)" } : {}),
        ...style,
      }}
      {...props}
    >
      {children}
    </select>
  ),
);
Select.displayName = "Select";
