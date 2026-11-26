import { useState, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Play, ChevronRight, ChevronDown, Trash2, Clock,
  CheckCircle, XCircle, Database, Table2, Columns3,
  History, AlertTriangle, Loader2,
} from "lucide-react";

interface Props { tenantId: string; }

const API = "/api/v1/sql-console";

interface TableInfo { table_name: string; table_type: string; }
interface ColumnInfo { column_name: string; data_type: string; is_nullable: string; column_default: string | null; }
interface HistoryItem {
  id: string; query_text: string; status: "completed" | "failed";
  duration_ms: number | null; row_count: number | null;
  error_message: string | null; executed_at: string;
  executed_by_name: string | null;
}
interface QueryResult {
  id: string; status: "completed" | "failed"; duration_ms: number;
  row_count: number | null; error_message: string | null;
  columns: string[]; rows: unknown[][];
}

function fmtDate(d: string) {
  return new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

// ── Schema tree ───────────────────────────────────────────────────────────────

function TableTree({ onInsert }: { onInsert: (text: string) => void }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [cols, setCols] = useState<Record<string, ColumnInfo[]>>({});
  const [loadingCols, setLoadingCols] = useState<string | null>(null);

  const { data: tables = [], isLoading } = useQuery<TableInfo[]>({
    queryKey: ["sql-tables"],
    queryFn: () => fetch(`${API}/tables`).then(r => r.json()),
    staleTime: 60_000,
  });

  async function toggleTable(name: string) {
    const next = !expanded[name];
    setExpanded(e => ({ ...e, [name]: next }));
    if (next && !cols[name]) {
      setLoadingCols(name);
      const data = await fetch(`${API}/tables/g1/${name}/columns`).then(r => r.json());
      setCols(c => ({ ...c, [name]: data }));
      setLoadingCols(null);
    }
  }

  if (isLoading) return <div className="p-3 text-xs text-gray-400">Carregando tabelas…</div>;

  return (
    <div className="text-xs overflow-y-auto h-full">
      <div className="p-2 border-b border-gray-200 dark:border-gray-700 flex items-center gap-1 text-gray-500 font-medium">
        <Database size={12} /> g1 ({tables.length})
      </div>
      {tables.map(t => (
        <div key={t.table_name}>
          <button
            onClick={() => toggleTable(t.table_name)}
            className="w-full flex items-center gap-1 px-2 py-1 hover:bg-gray-100 dark:hover:bg-gray-700 text-left"
          >
            {expanded[t.table_name] ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            <Table2 size={11} className="text-blue-500 shrink-0" />
            <span
              className="text-gray-800 dark:text-gray-200 truncate cursor-pointer hover:underline"
              onClick={e => { e.stopPropagation(); onInsert(`SELECT * FROM g1.${t.table_name} LIMIT 50`); }}
            >
              {t.table_name}
            </span>
          </button>
          {expanded[t.table_name] && (
            <div className="pl-6">
              {loadingCols === t.table_name && (
                <div className="py-1 text-gray-400 flex items-center gap-1"><Loader2 size={10} className="animate-spin" /> …</div>
              )}
              {(cols[t.table_name] ?? []).map(c => (
                <div key={c.column_name}
                  className="flex items-center gap-1 px-1 py-0.5 hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer"
                  onClick={() => onInsert(c.column_name)}
                >
                  <Columns3 size={10} className="text-gray-400 shrink-0" />
                  <span className="text-gray-700 dark:text-gray-300">{c.column_name}</span>
                  <span className="text-gray-400 ml-auto">{c.data_type.replace("character varying", "varchar").replace("timestamp with time zone", "timestamptz")}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Results table ─────────────────────────────────────────────────────────────

function ResultsTable({ result }: { result: QueryResult }) {
  if (result.status === "failed") {
    return (
      <div className="p-4 flex items-start gap-2 text-red-600 dark:text-red-400">
        <AlertTriangle size={16} className="shrink-0 mt-0.5" />
        <pre className="text-xs whitespace-pre-wrap font-mono">{result.error_message}</pre>
      </div>
    );
  }

  if (!result.columns.length) {
    return <div className="p-4 text-sm text-gray-500">Consulta executada — 0 linhas retornadas.</div>;
  }

  return (
    <div className="overflow-auto h-full">
      <table className="text-xs w-max min-w-full">
        <thead className="bg-gray-50 dark:bg-gray-900/60 sticky top-0 z-10">
          <tr>
            {result.columns.map(c => (
              <th key={c} className="text-left px-3 py-2 font-medium text-gray-600 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700 whitespace-nowrap">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
          {result.rows.map((row, i) => (
            <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
              {(row as unknown[]).map((cell, j) => (
                <td key={j} className="px-3 py-1.5 text-gray-800 dark:text-gray-200 whitespace-nowrap max-w-xs truncate font-mono">
                  {cell === null
                    ? <span className="text-gray-400 italic">NULL</span>
                    : String(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── History panel ─────────────────────────────────────────────────────────────

function HistoryPanel({ onSelect, onDelete }: {
  onSelect: (q: string) => void;
  onDelete: (id: string) => void;
}) {
  const { data: history = [] } = useQuery<HistoryItem[]>({
    queryKey: ["sql-history"],
    queryFn: () => fetch(`${API}/history?limit=100`).then(r => r.json()),
    refetchInterval: 15_000,
  });

  if (!history.length) return (
    <div className="p-4 text-xs text-gray-400 text-center">Nenhuma consulta ainda</div>
  );

  return (
    <div className="overflow-y-auto h-full text-xs divide-y divide-gray-100 dark:divide-gray-700">
      {history.map(h => (
        <div key={h.id} className="p-2 hover:bg-gray-50 dark:hover:bg-gray-700/30 group">
          <div className="flex items-center gap-1 mb-0.5">
            {h.status === "completed"
              ? <CheckCircle size={11} className="text-green-500 shrink-0" />
              : <XCircle size={11} className="text-red-500 shrink-0" />}
            <span className="text-gray-400">{fmtDate(h.executed_at)}</span>
            {h.duration_ms != null && <span className="text-gray-400 ml-auto">{h.duration_ms}ms</span>}
            <button onClick={() => onDelete(h.id)}
              className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 ml-1">
              <Trash2 size={11} />
            </button>
          </div>
          <button
            onClick={() => onSelect(h.query_text)}
            className="text-left text-gray-700 dark:text-gray-300 font-mono line-clamp-2 hover:text-blue-600 dark:hover:text-blue-400 w-full"
          >
            {h.query_text}
          </button>
          {h.error_message && (
            <p className="text-red-500 mt-0.5 truncate">{h.error_message}</p>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

type Panel = "history" | "schema";

export function SqlConsolePage({ tenantId }: Props) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [sql, setSql] = useState("SELECT * FROM g1.tenant LIMIT 10");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [panel, setPanel] = useState<Panel>("schema");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const insertText = useCallback((text: string) => {
    const ta = textareaRef.current;
    if (!ta) { setSql(text); return; }
    const { selectionStart: s, selectionEnd: e } = ta;
    setSql(prev => prev.slice(0, s) + text + prev.slice(e));
    setTimeout(() => { ta.selectionStart = ta.selectionEnd = s + text.length; ta.focus(); }, 0);
  }, []);

  const execute = useMutation({
    mutationFn: (query: string) =>
      fetch(`${API}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      }).then(r => r.json()),
    onSuccess: (data) => {
      setResult(data);
      qc.invalidateQueries({ queryKey: ["sql-history"] });
    },
  });

  const deleteHistory = useMutation({
    mutationFn: (id: string) => fetch(`${API}/history/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sql-history"] }),
  });

  function handleKeyDown(e: React.KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      execute.mutate(sql);
    }
  }

  return (
    <div className="flex h-[calc(100vh-64px)] overflow-hidden">
      {/* Left sidebar */}
      <div className="w-56 shrink-0 border-r border-gray-200 dark:border-gray-700 flex flex-col bg-white dark:bg-gray-900">
        <div className="flex border-b border-gray-200 dark:border-gray-700">
          <button onClick={() => setPanel("schema")}
            className={`flex-1 flex items-center justify-center gap-1 py-2 text-xs font-medium transition-colors
              ${panel === "schema" ? "bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400" : "text-gray-500 hover:text-gray-700"}`}>
            <Database size={12} /> Tabelas
          </button>
          <button onClick={() => setPanel("history")}
            className={`flex-1 flex items-center justify-center gap-1 py-2 text-xs font-medium transition-colors
              ${panel === "history" ? "bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400" : "text-gray-500 hover:text-gray-700"}`}>
            <History size={12} /> Histórico
          </button>
        </div>
        <div className="flex-1 overflow-hidden">
          {panel === "schema"
            ? <TableTree onInsert={insertText} />
            : <HistoryPanel onSelect={q => setSql(q)} onDelete={id => deleteHistory.mutate(id)} />}
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Editor */}
        <div className="flex flex-col border-b border-gray-200 dark:border-gray-700" style={{ height: "220px" }}>
          <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700">
            <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
              {t("nav.sql_console", "SQL Console")}
            </span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">Ctrl+Enter para executar</span>
              <button
                onClick={() => execute.mutate(sql)}
                disabled={execute.isPending || !sql.trim()}
                className="flex items-center gap-1.5 px-3 py-1 bg-blue-600 text-white text-xs rounded-md hover:bg-blue-700 disabled:opacity-50"
              >
                {execute.isPending
                  ? <Loader2 size={12} className="animate-spin" />
                  : <Play size={12} />}
                Executar
              </button>
            </div>
          </div>
          <textarea
            ref={textareaRef}
            value={sql}
            onChange={e => setSql(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
            className="flex-1 w-full p-3 font-mono text-sm bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 resize-none focus:outline-none"
            placeholder="SELECT * FROM g1.tenant LIMIT 10"
          />
        </div>

        {/* Result area */}
        <div className="flex-1 overflow-hidden flex flex-col">
          {/* Status bar */}
          {result && (
            <div className={`flex items-center gap-3 px-3 py-1.5 text-xs border-b border-gray-200 dark:border-gray-700
              ${result.status === "completed"
                ? "bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400"
                : "bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400"}`}>
              {result.status === "completed"
                ? <CheckCircle size={13} />
                : <XCircle size={13} />}
              {result.status === "completed"
                ? <>
                    <span>{result.row_count ?? 0} linha{result.row_count !== 1 ? "s" : ""}</span>
                    <span>·</span>
                    <span>{result.duration_ms}ms</span>
                    {(result.row_count ?? 0) >= 500 && (
                      <span className="text-amber-600 dark:text-amber-400 flex items-center gap-1">
                        <AlertTriangle size={11} /> Resultado limitado a 500 linhas
                      </span>
                    )}
                  </>
                : <span>Erro de execução</span>}
            </div>
          )}
          {/* Results or placeholder */}
          <div className="flex-1 overflow-hidden">
            {execute.isPending ? (
              <div className="flex items-center justify-center h-full text-gray-400">
                <Loader2 size={24} className="animate-spin" />
              </div>
            ) : result ? (
              <ResultsTable result={result} />
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-2">
                <Clock size={32} className="opacity-30" />
                <p className="text-sm">Execute uma consulta para ver os resultados</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
