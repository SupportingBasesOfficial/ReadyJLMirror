import { cn } from "@/lib/utils";

interface SkeletonProps {
  className?: string;
  width?: string | number;
  height?: string | number;
  rounded?: boolean;
  style?: React.CSSProperties;
}

export function Skeleton({ className, width, height, rounded, style: extraStyle }: SkeletonProps) {
  return (
    <div
      className={cn("animate-pulse", className)}
      style={{
        width,
        height,
        borderRadius: rounded ? 999 : "var(--radius-md)",
        background: "linear-gradient(90deg, var(--surface-2) 25%, var(--surface-3) 50%, var(--surface-2) 75%)",
        backgroundSize: "200% 100%",
        animation: "skeleton-shimmer 1.6s ease infinite",
        ...extraStyle,
      }}
    />
  );
}

export function SkeletonTable({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div
      className="rounded-xl border overflow-hidden"
      style={{ borderColor: "var(--border)" }}
    >
      <div className="px-4 py-3" style={{ background: "var(--surface-2)" }}>
        <div className="flex gap-4">
          {Array.from({ length: cols }).map((_, i) => (
            <Skeleton key={i} height={12} className="flex-1" />
          ))}
        </div>
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="px-4 py-3 flex gap-4"
          style={{ borderTop: "1px solid var(--border)", background: "var(--surface)" }}
        >
          {Array.from({ length: cols }).map((_, j) => (
            <Skeleton key={j} height={12} className="flex-1" style={{ opacity: 1 - j * 0.15 }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div
      className="rounded-xl border p-4 space-y-3"
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
    >
      <Skeleton height={16} width="60%" />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} height={12} width={i === lines - 1 ? "40%" : "100%"} />
      ))}
    </div>
  );
}
