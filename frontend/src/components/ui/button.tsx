import { cn } from "@/lib/utils";
import { forwardRef } from "react";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "outline" | "link" | "danger";
  size?: "xs" | "sm" | "md" | "lg";
  loading?: boolean;
}

const variants = {
  primary:   "bg-[var(--brand)] hover:bg-[var(--brand-hover)] text-white border-transparent",
  secondary: "bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-[var(--text)] border-[var(--border)] hover:border-[var(--border-2)]",
  ghost:     "bg-transparent hover:bg-[var(--surface-2)] text-[var(--text-muted)] hover:text-[var(--text)] border-transparent",
  outline:   "bg-transparent border-[var(--border)] hover:border-[var(--brand)] hover:text-[var(--brand)] text-[var(--text)]",
  link:      "bg-transparent text-[var(--brand)] hover:text-[var(--brand-hover)] hover:underline border-transparent p-0 h-auto",
  danger:    "bg-[var(--danger-bg)] hover:bg-[var(--danger-bg)] text-[var(--danger)] border-[var(--danger-border)] hover:border-[var(--danger)]",
};

const sizes = {
  xs: "px-2 py-0.5 text-[11px] rounded-[var(--radius-sm)]",
  sm: "px-2.5 py-1 text-xs rounded-[var(--radius-sm)]",
  md: "px-3.5 py-1.5 text-sm rounded-[var(--radius-md)]",
  lg: "px-5 py-2.5 text-sm rounded-[var(--radius-md)]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", loading, className, children, disabled, ...props }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 font-medium border cursor-pointer",
        "transition-all duration-150",
        "disabled:opacity-50 disabled:pointer-events-none",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {loading && (
        <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25"/>
          <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
        </svg>
      )}
      {children}
    </button>
  ),
);
Button.displayName = "Button";
