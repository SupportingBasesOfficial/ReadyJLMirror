import { cn } from "@/lib/utils";

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "interactive" | "elevated" | "flat" | "accent";
  accentColor?: string;
}

export function Card({ children, className, variant = "default", accentColor, onClick, ...props }: CardProps) {
  const interactive = variant === "interactive" || !!onClick;
  const isFlat = variant === "flat";
  const isElevated = variant === "elevated";
  const isAccent = variant === "accent";

  const baseStyle: React.CSSProperties = {};
  if (isElevated) {
    baseStyle.background = "var(--card-gradient-elevated)";
    baseStyle.boxShadow = "var(--shadow-md)";
  } else if (!isFlat) {
    baseStyle.background = "var(--card-gradient)";
  }
  if (isAccent) {
    baseStyle.background = "var(--card-gradient)";
    baseStyle.borderTop = `2px solid ${accentColor ?? "var(--brand)"}`;
    baseStyle.paddingTop = "15px";
  }

  return (
    <div
      className={cn(
        "rounded-xl border p-4",
        isFlat
          ? "bg-transparent border-transparent"
          : isElevated
          ? "border-[var(--border-2)]"
          : "border-[var(--border)]",
        interactive && [
          "cursor-pointer transition-all duration-200",
          "hover:border-[var(--border-2)] hover:brightness-105",
        ],
        className,
      )}
      style={{ ...baseStyle, ...(props.style ?? {}) }}
      onClick={onClick}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between mb-3", className)}>
      {children}
    </div>
  );
}
