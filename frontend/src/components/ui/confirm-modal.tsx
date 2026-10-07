import { useEffect } from "react";
import { X, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

interface ConfirmModalProps {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  isPending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  title,
  description,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  destructive = false,
  isPending = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl p-6">
        <button
          onClick={onCancel}
          className="absolute top-3 right-3 text-[var(--text-muted)] hover:text-[var(--text)] cursor-pointer"
          style={{ position: "absolute" }}
        >
          <X size={16} />
        </button>

        <div className="flex items-start gap-3 mb-4">
          {destructive && (
            <AlertTriangle
              size={20}
              className="flex-shrink-0 mt-0.5"
              style={{ color: "var(--red)" }}
            />
          )}
          <div>
            <h3 className="text-sm font-semibold" style={{ color: "var(--text)" }}>
              {title}
            </h3>
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
              {description}
            </p>
          </div>
        </div>

        <div className="flex gap-2">
          <Button
            onClick={onConfirm}
            disabled={isPending}
            style={destructive ? { background: "var(--red)", color: "#fff" } : undefined}
            className="flex-1"
          >
            {isPending ? <Spinner className="w-3 h-3" /> : confirmLabel}
          </Button>
          <Button autoFocus variant="ghost" onClick={onCancel} className="flex-1">
            {cancelLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
