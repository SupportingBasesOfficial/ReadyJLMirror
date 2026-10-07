import { useState, useRef, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import DOMPurify from "dompurify";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { marked } from "marked";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { ConfirmModal } from "@/components/ui/confirm-modal";

// ── Types ──────────────────────────────────────────────────────────────────

interface Category {
  category_id: string;
  name: string;
  parent_id: string | null;
  slug: string;
}

interface ArticleSummary {
  article_id: string;
  title: string;
  status: "draft" | "published" | "archived";
  category_id: string | null;
  category_name: string | null;
  tags: string[];
  created_by: string;
  updated_at: string;
  body_length: number;
}

interface ArticleDetail extends ArticleSummary {
  body: string;
  incidents: { incident_id: string; linked_by: string; linked_at: string }[];
}

// ── Status badge ───────────────────────────────────────────────────────────

const STATUS_COLOR = {
  draft: "var(--text-muted)",
  published: "var(--green, #22c55e)",
  archived: "#94a3b8",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span style={{ color: (STATUS_COLOR as Record<string, string>)[status] ?? "var(--text-muted)", fontSize: "0.7rem", fontWeight: 600, textTransform: "uppercase" }}>
      {status}
    </span>
  );
}

// ── Article editor modal ───────────────────────────────────────────────────

function ArticleModal({
  categories,
  article,
  onClose,
  onSave,
}: {
  categories: Category[];
  article?: ArticleDetail;
  onClose: () => void;
  onSave: (data: { title: string; body: string; category_id: string | null; status: string; tags: string[] }) => void;
}) {
  const [title, setTitle] = useState(article?.title ?? "");
  const [body, setBody] = useState(article?.body ?? "");
  const [catId, setCatId] = useState<string>(article?.category_id ?? "");
  const [articleStatus, setArticleStatus] = useState(article?.status ?? "draft");
  const [tagsRaw, setTagsRaw] = useState((article?.tags ?? []).join(", "));

  const isEditing = !!article;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "flex-start", justifyContent: "center", overflowY: "auto", zIndex: 50, padding: "40px 16px" }}>
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 24, width: "100%", maxWidth: 720 }}>
        <h3 style={{ fontWeight: 600, marginBottom: 16 }}>{isEditing ? "Edit article" : "New article"}</h3>

        <label style={{ fontSize: "0.82rem", display: "block", marginBottom: 10 }}>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Article title" style={{ display: "block", width: "100%", boxSizing: "border-box", border: "1px solid var(--border)", borderRadius: 6, padding: "7px 10px", background: "var(--surface-2)", color: "var(--text)", marginTop: 4, fontSize: "0.85rem" }} />
        </label>

        <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
          <label style={{ fontSize: "0.82rem", flex: 1 }}>
            Category
            <select value={catId} onChange={(e) => setCatId(e.target.value)} style={{ display: "block", width: "100%", border: "1px solid var(--border)", borderRadius: 6, padding: "7px 8px", background: "var(--surface-2)", color: "var(--text)", marginTop: 4, fontSize: "0.82rem" }}>
              <option value="">— no category —</option>
              {categories.map((c) => <option key={c.category_id} value={c.category_id}>{c.name}</option>)}
            </select>
          </label>
          <label style={{ fontSize: "0.82rem", flex: 1 }}>
            Status
            <select value={articleStatus} onChange={(e) => setArticleStatus(e.target.value as "draft" | "published" | "archived")} style={{ display: "block", width: "100%", border: "1px solid var(--border)", borderRadius: 6, padding: "7px 8px", background: "var(--surface-2)", color: "var(--text)", marginTop: 4, fontSize: "0.82rem" }}>
              <option value="draft">Draft</option>
              <option value="published">Published</option>
              <option value="archived">Archived</option>
            </select>
          </label>
        </div>

        <label style={{ fontSize: "0.82rem", display: "block", marginBottom: 10 }}>
          Body (Markdown)
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={14} style={{ display: "block", width: "100%", boxSizing: "border-box", border: "1px solid var(--border)", borderRadius: 6, padding: "7px 10px", background: "var(--surface-2)", color: "var(--text)", marginTop: 4, fontSize: "0.82rem", fontFamily: "monospace", resize: "vertical" }} />
        </label>

        <label style={{ fontSize: "0.82rem", display: "block", marginBottom: 16 }}>
          Tags (comma-separated)
          <input value={tagsRaw} onChange={(e) => setTagsRaw(e.target.value)} placeholder="e.g. networking, dns, runbook" style={{ display: "block", width: "100%", boxSizing: "border-box", border: "1px solid var(--border)", borderRadius: 6, padding: "7px 10px", background: "var(--surface-2)", color: "var(--text)", marginTop: 4, fontSize: "0.82rem" }} />
        </label>

        <div style={{ display: "flex", gap: 8 }}>
          <Button
            size="sm"
            onClick={() =>
              onSave({
                title: title.trim(),
                body,
                category_id: catId || null,
                status: articleStatus,
                tags: tagsRaw.split(",").map((t) => t.trim()).filter(Boolean),
              })
            }
            disabled={!title.trim()}
          >
            {isEditing ? "Save changes" : "Create article"}
          </Button>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}

// ── Article detail view ────────────────────────────────────────────────────

function ArticleDetailView({
  article,
  onEdit,
  onDelete,
  onBack,
}: {
  article: ArticleDetail;
  onEdit: () => void;
  onDelete: () => void;
  onBack: () => void;
}) {
  const qc = useQueryClient();
  const [incidentInput, setIncidentInput] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const linkIncident = useMutation({
    mutationFn: (incidentId: string) =>
      api.post(`/api/v1/kb/articles/${article.article_id}/incidents`, { incident_id: incidentId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kb-article", article.article_id] });
      setIncidentInput("");
    },
  });

  const unlinkIncident = useMutation({
    mutationFn: (incidentId: string) =>
      api.delete(`/api/v1/kb/articles/${article.article_id}/incidents/${incidentId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["kb-article", article.article_id] }),
  });

  return (
    <div>
      <style>{`
        .kb-prose h1, .kb-prose h2, .kb-prose h3, .kb-prose h4 { font-weight: 600; margin: 0.9em 0 0.4em; line-height: 1.3; }
        .kb-prose h1 { font-size: 1.3em; }
        .kb-prose h2 { font-size: 1.15em; }
        .kb-prose h3 { font-size: 1.05em; }
        .kb-prose h4 { font-size: 0.95em; }
        .kb-prose p { margin: 0.5em 0; }
        .kb-prose strong, .kb-prose b { font-weight: 600; }
        .kb-prose em, .kb-prose i { font-style: italic; }
        .kb-prose a { color: var(--brand); text-decoration: underline; }
        .kb-prose code { font-family: monospace; background: var(--surface); padding: 1px 5px; border-radius: 3px; font-size: 0.88em; }
        .kb-prose pre { background: var(--surface); padding: 10px 12px; border-radius: 6px; overflow-x: auto; margin: 0.6em 0; }
        .kb-prose pre code { background: none; padding: 0; }
        .kb-prose ul, .kb-prose ol { padding-left: 1.6em; margin: 0.5em 0; }
        .kb-prose li { margin: 0.2em 0; }
        .kb-prose blockquote { border-left: 3px solid var(--border); padding-left: 1em; color: var(--text-muted); margin: 0.5em 0; }
        .kb-prose hr { border: none; border-top: 1px solid var(--border); margin: 1em 0; }
        .kb-prose table { border-collapse: collapse; width: 100%; margin: 0.5em 0; font-size: 0.9em; }
        .kb-prose th, .kb-prose td { border: 1px solid var(--border); padding: 5px 10px; }
        .kb-prose th { background: var(--surface); font-weight: 600; }
      `}</style>

      <button onClick={onBack} style={{ color: "var(--brand)", background: "none", border: "none", cursor: "pointer", fontSize: "0.82rem", marginBottom: 12 }}>
        ← Back to articles
      </button>

      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 8, gap: 10 }}>
        <div>
          <h2 style={{ fontWeight: 700, marginBottom: 4 }}>{article.title}</h2>
          <div style={{ display: "flex", gap: 10, alignItems: "center", fontSize: "0.78rem", color: "var(--text-muted)" }}>
            <StatusBadge status={article.status} />
            {article.category_name && <span>in {article.category_name}</span>}
            <span>updated {new Date(article.updated_at).toLocaleDateString()}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <Button variant="secondary" size="sm" onClick={onEdit}>Edit</Button>
          <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(true)}>Delete</Button>
        </div>
      </div>

      {article.tags.length > 0 && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 16 }}>
          {article.tags.map((tag) => (
            <span key={tag} style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 999, padding: "1px 8px", fontSize: "0.72rem", color: "var(--text-muted)" }}>{tag}</span>
          ))}
        </div>
      )}

      {/* Body — rendered Markdown */}
      {article.body ? (
        <div
          className="kb-prose"
          style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, padding: 16, marginBottom: 20, fontSize: "0.85rem", lineHeight: 1.7, minHeight: 80, color: "var(--text)" }}
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked(article.body) as string) }}
        />
      ) : (
        <div style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, padding: 16, marginBottom: 20, minHeight: 80 }}>
          <span style={{ color: "var(--text-muted)", fontSize: "0.83rem" }}>No content yet.</span>
        </div>
      )}

      {/* Incident links */}
      <div>
        <h3 style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: 10 }}>Linked incidents</h3>
        {article.incidents.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: "0.82rem", marginBottom: 10 }}>No incidents linked.</p>
        ) : (
          <div style={{ marginBottom: 10 }}>
            {article.incidents.map((inc) => (
              <div key={inc.incident_id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 10px", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 6, marginBottom: 4, fontSize: "0.82rem" }}>
                <span style={{ fontFamily: "monospace", color: "var(--brand)" }}>{inc.incident_id}</span>
                <span style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>linked by {inc.linked_by}</span>
                <button onClick={() => unlinkIncident.mutate(inc.incident_id)} style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", fontSize: "0.75rem" }}>unlink</button>
              </div>
            ))}
          </div>
        )}
        <form onSubmit={(e) => { e.preventDefault(); if (incidentInput.trim()) linkIncident.mutate(incidentInput.trim()); }} style={{ display: "flex", gap: 8 }}>
          <input value={incidentInput} onChange={(e) => setIncidentInput(e.target.value)} placeholder="Incident ID to link" style={{ flex: 1, border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", background: "var(--surface-2)", color: "var(--text)", fontSize: "0.82rem" }} />
          <Button type="submit" size="sm" disabled={!incidentInput.trim() || linkIncident.isPending}>
            {linkIncident.isPending ? "Linking…" : "Link"}
          </Button>
        </form>
      </div>

      {confirmDelete && (
        <ConfirmModal
          title="Excluir artigo"
          description="Esta ação é permanente. O artigo será removido e não poderá ser recuperado."
          confirmLabel="Excluir"
          cancelLabel="Cancelar"
          destructive={true}
          isPending={false}
          onConfirm={() => { setConfirmDelete(false); onDelete(); }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

function loadKbStatus(tenantId: string): string {
  try {
    return localStorage.getItem(`jlm_kb_status_${tenantId}`) ?? "published";
  } catch { return "published"; }
}

export function KnowledgeBasePage({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [filterCat, setFilterCat] = useState("");
  const [filterStatus, setFilterStatus] = useState(() => loadKbStatus(tenantId));

  const setAndSaveStatus = (v: string) => {
    setFilterStatus(v);
    try { localStorage.setItem(`jlm_kb_status_${tenantId}`, v); } catch { /* */ }
  };
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [searchParams] = useSearchParams();
  useEffect(() => {
    const articleId = searchParams.get("article");
    if (articleId) setSelectedId(articleId);
  }, []);
  const [showNewCat, setShowNewCat] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [deletingCatId, setDeletingCatId] = useState<string | null>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [debouncedQ, setDebouncedQ] = useState("");

  const { data: categories = [] } = useQuery<Category[]>({
    queryKey: ["kb-categories", tenantId],
    queryFn: () => api.get<Category[]>("/api/v1/kb/categories"),
  });

  const { data: articles = [], isLoading } = useQuery<ArticleSummary[]>({
    queryKey: ["kb-articles", tenantId, debouncedQ, filterCat, filterStatus],
    queryFn: () => {
      const params: Record<string, string> = {};
      if (debouncedQ) params.q = debouncedQ;
      if (filterCat) params.category_id = filterCat;
      if (filterStatus) params.status = filterStatus;
      const qs = new URLSearchParams(params).toString();
      const url = qs ? `/api/v1/kb/articles?${qs}` : "/api/v1/kb/articles";
      return api.get<ArticleSummary[]>(url);
    },
  });

  const { data: articleDetail } = useQuery<ArticleDetail>({
    queryKey: ["kb-article", selectedId],
    queryFn: () => api.get<ArticleDetail>(`/api/v1/kb/articles/${selectedId}`),
    enabled: !!selectedId,
  });

  const createArticle = useMutation({
    mutationFn: (data: Parameters<typeof api.post>[1]) => api.post<ArticleSummary>("/api/v1/kb/articles", data),
    onSuccess: (data) => { qc.invalidateQueries({ queryKey: ["kb-articles"] }); setShowEditor(false); setSelectedId(data.article_id); },
  });

  const updateArticle = useMutation({
    mutationFn: ({ id, data }: { id: string; data: object }) =>
      api.put<ArticleSummary>(`/api/v1/kb/articles/${id}`, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["kb-articles"] }); qc.invalidateQueries({ queryKey: ["kb-article", selectedId] }); setShowEditor(false); },
  });

  const deleteArticle = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/kb/articles/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kb-articles"] });
      setSelectedId(null);
      toast("Artigo excluído.", "success");
    },
    onError: () => toast("Erro ao excluir artigo.", "error"),
  });

  const createCategory = useMutation({
    mutationFn: (name: string) => api.post<Category>("/api/v1/kb/categories", { name }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["kb-categories"] }); setNewCatName(""); },
  });

  const deleteCategory = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/kb/categories/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kb-categories"] });
      setDeletingCatId(null);
      toast("Categoria excluída.", "success");
    },
    onError: () => { setDeletingCatId(null); toast("Erro ao excluir categoria.", "error"); },
  });

  const handleSearch = (val: string) => {
    setSearch(val);
    clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => setDebouncedQ(val), 350);
  };

  if (selectedId && articleDetail && !showEditor) {
    return (
      <ArticleDetailView
        article={articleDetail}
        onEdit={() => setShowEditor(true)}
        onDelete={() => deleteArticle.mutate(selectedId)}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  const catToDelete = categories.find((c) => c.category_id === deletingCatId);

  return (
    <div>
      {showEditor && (
        <ArticleModal
          categories={categories}
          article={selectedId && articleDetail ? articleDetail : undefined}
          onClose={() => setShowEditor(false)}
          onSave={(data) => {
            if (selectedId) {
              updateArticle.mutate({ id: selectedId, data });
            } else {
              createArticle.mutate(data);
            }
          }}
        />
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <h2 style={{ fontWeight: 600 }}>Knowledge Base</h2>
        <Button size="sm" onClick={() => { setSelectedId(null); setShowEditor(true); }}>
          New article
        </Button>
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <input
          value={search}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="Search articles…"
          style={{ flex: 2, minWidth: 160, border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", background: "var(--surface-2)", color: "var(--text)", fontSize: "0.82rem" }}
        />
        <select value={filterStatus} onChange={(e) => setAndSaveStatus(e.target.value)} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", background: "var(--surface-2)", color: "var(--text)", fontSize: "0.82rem" }}>
          <option value="">All statuses</option>
          <option value="published">Published</option>
          <option value="draft">Draft</option>
          <option value="archived">Archived</option>
        </select>
        <select value={filterCat} onChange={(e) => setFilterCat(e.target.value)} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", background: "var(--surface-2)", color: "var(--text)", fontSize: "0.82rem" }}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.category_id} value={c.category_id}>{c.name}</option>)}
        </select>
        <Button variant="secondary" size="sm" onClick={() => setShowNewCat((v) => !v)}>
          + Category
        </Button>
      </div>

      {/* Category management panel */}
      {showNewCat && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 14, marginBottom: 14, background: "var(--surface-2)" }}>
          <h3 style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: 10 }}>Gerenciar categorias</h3>

          {categories.length > 0 ? (
            <div style={{ marginBottom: 12 }}>
              {categories.map((c) => (
                <div key={c.category_id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 8px", borderRadius: 6, marginBottom: 3, background: "var(--surface)", border: "1px solid var(--border)" }}>
                  <span style={{ fontSize: "0.82rem", color: "var(--text)" }}>{c.name}</span>
                  <button
                    onClick={() => setDeletingCatId(c.category_id)}
                    style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", fontSize: "0.75rem", padding: "2px 6px" }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "var(--red, #ef4444)")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
                  >
                    Excluir
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginBottom: 10 }}>Nenhuma categoria criada.</p>
          )}

          <form onSubmit={(e) => { e.preventDefault(); if (newCatName.trim()) createCategory.mutate(newCatName.trim()); }} style={{ display: "flex", gap: 8 }}>
            <input value={newCatName} onChange={(e) => setNewCatName(e.target.value)} placeholder="Nova categoria…" style={{ flex: 1, border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", background: "var(--surface)", color: "var(--text)", fontSize: "0.82rem" }} />
            <Button type="submit" size="sm" disabled={!newCatName.trim() || createCategory.isPending}>Criar</Button>
            <Button variant="secondary" size="sm" type="button" onClick={() => setShowNewCat(false)}>Fechar</Button>
          </form>
        </div>
      )}

      {/* Article list */}
      {isLoading ? (
        <div style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>Loading…</div>
      ) : articles.length === 0 ? (
        <div style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>No articles found.</div>
      ) : (
        <div>
          {articles.map((a) => (
            <div
              key={a.article_id}
              onClick={() => setSelectedId(a.article_id)}
              style={{ padding: "10px 14px", border: "1px solid var(--border)", borderRadius: 8, marginBottom: 6, cursor: "pointer", background: "var(--surface)", transition: "border-color 0.15s" }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--brand)")}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 3 }}>
                <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>{a.title}</span>
                <StatusBadge status={a.status} />
                {a.category_name && <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{a.category_name}</span>}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {a.tags.slice(0, 4).map((tag) => (
                  <span key={tag} style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 999, padding: "0 7px", fontSize: "0.7rem", color: "var(--text-muted)" }}>{tag}</span>
                ))}
                <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginLeft: "auto" }}>
                  {new Date(a.updated_at).toLocaleDateString()}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Confirm delete category modal */}
      {deletingCatId && catToDelete && (
        <ConfirmModal
          title="Excluir categoria"
          description={`Excluir a categoria "${catToDelete.name}"? Artigos vinculados perderão esta categoria.`}
          confirmLabel="Excluir"
          cancelLabel="Cancelar"
          destructive={true}
          isPending={deleteCategory.isPending}
          onConfirm={() => deleteCategory.mutate(deletingCatId)}
          onCancel={() => setDeletingCatId(null)}
        />
      )}
    </div>
  );
}
