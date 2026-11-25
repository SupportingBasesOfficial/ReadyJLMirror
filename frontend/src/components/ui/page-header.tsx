import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  back?: { label: string; onClick: () => void };
  badge?: React.ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  description,
  actions,
  back,
  badge,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn("flex items-start justify-between gap-4 mb-5", className)}>
      <div className="flex flex-col gap-1 min-w-0">
        {back && (
          <button
            onClick={back.onClick}
            className="flex items-center gap-1 text-xs mb-1 transition-colors w-fit"
            style={{ color: "var(--text-dim)" }}
            onMouseEnter={e => (e.currentTarget.style.color = "var(--text-muted)")}
            onMouseLeave={e => (e.currentTarget.style.color = "var(--text-dim)")}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            {back.label}
          </button>
        )}
        <div className="flex items-center gap-2.5 flex-wrap">
          <h1
            className="text-lg font-semibold leading-none tracking-tight truncate"
            style={{ color: "var(--text)", letterSpacing: "-0.02em" }}
          >
            {title}
          </h1>
          {badge}
        </div>
        {description && (
          <p className="text-sm mt-0.5" style={{ color: "var(--text-dim)" }}>
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex items-center gap-2 flex-shrink-0">
          {actions}
        </div>
      )}
    </div>
  );
}
