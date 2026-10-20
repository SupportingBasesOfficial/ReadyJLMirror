import { useState, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Bug } from "lucide-react";

interface Props {
  screenId: string;
  screenUrl?: string;
}

interface BugPayload {
  screen_id: string;
  screen_url?: string;
  title: string;
  description: string;
  error_info?: Record<string, unknown>;
  user_agent?: string;
}

export function BugReportButton({ screenId, screenUrl }: Props) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [sent, setSent] = useState(false);
  const [titleError, setTitleError] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);

  const mut = useMutation({
    mutationFn: (payload: BugPayload) => api.post("/api/v1/bugs", payload),
    onSuccess: () => { setSent(true); },
  });

  function handleOpen() {
    setOpen(true);
    setSent(false);
    setTitle("");
    setDescription("");
    setTitleError("");
    setTimeout(() => titleRef.current?.focus(), 50);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      setTitleError("Informe um título para o bug.");
      titleRef.current?.focus();
      return;
    }
    setTitleError("");
    mut.mutate({
      screen_id: screenId,
      screen_url: screenUrl ?? window.location.pathname,
      title: title.trim(),
      description: description.trim(),
      user_agent: navigator.userAgent,
    });
  }

  function handleClose() {
    setOpen(false);
    setTitle("");
    setDescription("");
    setTitleError("");
    setSent(false);
  }

  return (
    <>
      <button
        onClick={handleOpen}
        title="Informar bug"
        className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-md border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--red,#ef4444)] hover:border-[var(--red,#ef4444)] transition-colors"
      >
        <Bug size={13} />
        <span className="hidden sm:inline">Bug</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
        >
          <div className="bg-[var(--surface-1)] border border-[var(--border)] rounded-xl shadow-xl w-full max-w-md mx-4 p-5">
            {sent ? (
              <div className="text-center py-4">
                <p className="text-sm font-medium mb-1">Bug registrado</p>
                <p className="text-xs text-[var(--text-muted)] mb-4">
                  Obrigado pelo feedback. Nossa equipe vai analisar.
                </p>
                <button
                  onClick={handleClose}
                  className="text-xs px-4 py-1.5 rounded-md border border-[var(--border)] hover:bg-[var(--surface-2)]"
                >
                  Fechar
                </button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-3">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <Bug size={15} className="text-[var(--red,#ef4444)]" />
                    <span className="text-sm font-semibold">Informar bug</span>
                  </div>
                  <span className="text-[10px] font-mono text-[var(--text-muted)] bg-[var(--surface-2)] px-2 py-0.5 rounded">
                    {screenId}
                  </span>
                </div>

                <div>
                  <label className="block text-xs text-[var(--text-muted)] mb-1">
                    Título
                  </label>
                  <input
                    ref={titleRef}
                    value={title}
                    onChange={(e) => { setTitle(e.target.value); setTitleError(""); }}
                    placeholder="Ex: Tabela não carrega ao filtrar por data"
                    className="w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--brand,#6366f1)]"
                  />
                  {titleError && (
                    <p className="text-[11px] text-[var(--red,#ef4444)] mt-1">{titleError}</p>
                  )}
                </div>

                <div>
                  <label className="block text-xs text-[var(--text-muted)] mb-1">
                    Descrição (opcional)
                  </label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Descreva o comportamento esperado vs. o que aconteceu..."
                    rows={3}
                    className="w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-[var(--brand,#6366f1)]"
                  />
                </div>

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="text-xs px-3 py-1.5 rounded-md border border-[var(--border)] hover:bg-[var(--surface-2)]"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={mut.isPending}
                    className="text-xs px-3 py-1.5 rounded-md bg-[var(--red,#ef4444)] text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {mut.isPending ? "Enviando…" : "Enviar"}
                  </button>
                </div>

                {mut.isError && (
                  <p className="text-[11px] text-[var(--red,#ef4444)]">
                    Erro ao enviar. Tente novamente.
                  </p>
                )}
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
