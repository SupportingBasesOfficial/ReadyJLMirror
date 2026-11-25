import { cn } from "@/lib/utils";

interface BadgeProps {
  children: React.ReactNode;
  variant?: "default" | "success" | "warning" | "danger" | "info" | "muted";
  className?: string;
}

const variants = {
  default: "bg-[var(--surface-2)] text-[var(--text-muted)] border-[var(--border)]",
  success: "bg-[var(--success-bg)] text-[var(--success)] border-[var(--success-border)]",
  warning: "bg-[var(--warning-bg)] text-[var(--warning)] border-[var(--warning-border)]",
  danger:  "bg-[var(--danger-bg)] text-[var(--danger)] border-[var(--danger-border)]",
  info:    "bg-[var(--info-bg)] text-[var(--info)] border-[var(--info-border)]",
  muted:   "bg-transparent text-[var(--text-dim)] border-transparent",
};

export function Badge({ children, variant = "default", className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border",
        variants[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
