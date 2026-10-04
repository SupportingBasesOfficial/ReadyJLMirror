import { cn } from "@/lib/utils";

interface BadgeProps {
  children: React.ReactNode;
  variant?: "default" | "success" | "warning" | "danger" | "info" | "muted";
  className?: string;
}

const variants = {
  default: "bg-[var(--surface-2)] text-[var(--text-muted)] border-[var(--border)]",
  success: "bg-[#16301f] text-[var(--green)] border-[#1d4228]",
  warning: "bg-[#3a2a1a] text-[var(--yellow)] border-[#4a3820]",
  danger: "bg-[#3a1a1a] text-[var(--red)] border-[#4a2020]",
  info: "bg-[#1a2640] text-[var(--brand)] border-[#243050]",
  muted: "bg-transparent text-[var(--text-dim)] border-transparent",
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
