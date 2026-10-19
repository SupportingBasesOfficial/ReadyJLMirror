import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useCanOperate } from "@/hooks/usePermission";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { useToast } from "@/components/ui/toast";

interface Schedule {
  schedule_id: string;
  name: string;
  description?: string;
  timezone: string;
  enabled: boolean;
  created_at: string;
  current_principal: string | null;
  current_display_name: string | null;
}

interface Shift {
  shift_id: string;
  principal_id: string;
  display_name: string | null;
  starts_at: string;
  ends_at: string;
  created_at: string;
}

interface Member {
  membership_id: string;
  principal_id: string;
  role: string;
  state: string;
}

// Palette for up to 8 people on the same schedule
const SHIFT_COLORS = [
  "#3b82f6", "#8b5cf6", "#ec4899", "#f59e0b",
  "#10b981", "#ef4444", "#06b6d4", "#84cc16",
];

function startOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function fmtDay(d: Date): string {
  return d.toLocaleDateString("pt-BR", { weekday: "short", day: "numeric", month: "short" });
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function personLabel(shift: Shift): string {
  return shift.display_name || shift.principal_id;
}

// ---------------------------------------------------------------------------
// Weekly calendar
// ---------------------------------------------------------------------------

function WeekCalendar({
  scheduleId,
  tenantId: _tenantId,
  canOperate,
  members,
  weekStart,
}: {
  scheduleId: string;
  tenantId: string;
  canOperate: boolean;
  members: Member[];
  weekStart: Date;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [addingDay, setAddingDay] = useState<string | null>(null); // ISO date string
  const [deletingShift, setDeletingShift] = useState<Shift | null>(null);

  const weekEnd = addDays(weekStart, 7);

  const q = useQuery({
    queryKey: ["oncall-shifts", scheduleId, weekStart.toISOString()],
    queryFn: () =>
      api.get<Shift[]>(
        `/api/v1/oncall/schedules/${scheduleId}/shifts` +
          `?from_ts=${weekStart.toISOString()}&till_ts=${weekEnd.toISOString()}`
      ),
  });

  const deleteMut = useMutation({
    mutationFn: (shift: Shift) =>
      api.delete(`/api/v1/oncall/schedules/${scheduleId}/shifts/${shift.shift_id}`),
    onSuccess: () => {
      toast("Turno removido.", "success");
      qc.invalidateQueries({ queryKey: ["oncall-shifts", scheduleId] });
      qc.invalidateQueries({ queryKey: ["oncall-schedules"] });
      setDeletingShift(null);
    },
    onError: () => toast("Erro ao remover turno.", "error"),
  });

  const shifts = q.data ?? [];

  // Assign stable colors by principal
  const principalColor = useMemo(() => {
    const map = new Map<string, string>();
    shifts.forEach((s) => {
      if (!map.has(s.principal_id)) {
        map.set(s.principal_id, SHIFT_COLORS[map.size % SHIFT_COLORS.length]);
      }
    });
    return map;
  }, [shifts]);

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  return (
    <div className="space-y-3">
      {deletingShift && (
        <ConfirmModal
          title="Remover turno"
          description={`Remover turno de "${personLabel(deletingShift)}"?`}
          confirmLabel="Remover"
          destructive
          isPending={deleteMut.isPending}
          onConfirm={() => deleteMut.mutate(deletingShift)}
          onCancel={() => setDeletingShift(null)}
        />
      )}

      {q.isLoading && (
        <div className="flex justify-center py-4"><Spinner /></div>
      )}

      <div className="grid grid-cols-7 gap-1">
        {days.map((day) => {
          const dayIso = day.toISOString().slice(0, 10);
          const isToday = dayIso === new Date().toISOString().slice(0, 10);

          const dayShifts = shifts.filter((s) => {
            const start = new Date(s.starts_at);
            const end = new Date(s.ends_at);
            const dayEnd = addDays(day, 1);
            return start < dayEnd && end > day;
          });

          return (
            <div key={dayIso} className="min-h-[120px]">
              <div
                className={`text-[10px] font-medium mb-1 px-1 py-0.5 rounded ${
                  isToday
                    ? "bg-[var(--brand)] text-white"
                    : "text-[var(--text-muted)]"
                }`}
              >
                {fmtDay(day)}
              </div>

              <div className="space-y-1 min-h-[80px]">
                {dayShifts.map((s) => {
                  const color = principalColor.get(s.principal_id) ?? SHIFT_COLORS[0];
                  return (
                    <div
                      key={s.shift_id}
                      className="rounded px-1 py-0.5 text-[10px] leading-tight text-white cursor-default group relative"
                      style={{ backgroundColor: color }}
                      title={`${personLabel(s)} — ${fmtTime(s.starts_at)} → ${fmtTime(s.ends_at)}`}
                    >
                      <div className="font-medium truncate">{personLabel(s)}</div>
                      <div className="opacity-80">
                        {fmtTime(s.starts_at)}–{fmtTime(s.ends_at)}
                      </div>
                      {canOperate && (
                        <button
                          onClick={() => setDeletingShift(s)}
                          className="absolute top-0.5 right-0.5 opacity-0 group-hover:opacity-100 text-white/80 hover:text-white text-[9px] font-bold"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  );
                })}

                {canOperate && addingDay !== dayIso && (
                  <button
                    onClick={() => setAddingDay(dayIso)}
                    className="w-full text-[10px] text-[var(--text-muted)] hover:text-[var(--brand)] py-1 border border-dashed border-[var(--border)] rounded hover:border-[var(--brand)] transition-colors"
                  >
                    + turno
                  </button>
                )}

                {canOperate && addingDay === dayIso && (
                  <AddShiftInline
                    scheduleId={scheduleId}
                    dayIso={dayIso}
                    members={members}
                    onDone={() => {
                      setAddingDay(null);
                      qc.invalidateQueries({ queryKey: ["oncall-shifts", scheduleId] });
                      qc.invalidateQueries({ queryKey: ["oncall-schedules"] });
                    }}
                    onCancel={() => setAddingDay(null)}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AddShiftInline({
  scheduleId,
  dayIso,
  members,
  onDone,
  onCancel,
}: {
  scheduleId: string;
  dayIso: string;
  members: Member[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const { toast } = useToast();
  const [principalId, setPrincipalId] = useState(members[0]?.principal_id ?? "");
  const [startsAt, setStartsAt] = useState(`${dayIso}T09:00`);
  const [endsAt, setEndsAt] = useState(`${dayIso}T17:00`);

  const inp = "w-full text-[10px] bg-[var(--surface)] border border-[var(--border)] rounded px-1 py-0.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]";

  const mut = useMutation({
    mutationFn: () => {
      const member = members.find((m) => m.principal_id === principalId);
      return api.post(`/api/v1/oncall/schedules/${scheduleId}/shifts`, {
        principal_id: principalId,
        display_name: member?.principal_id ?? principalId,
        starts_at: new Date(startsAt).toISOString(),
        ends_at: new Date(endsAt).toISOString(),
      });
    },
    onSuccess: () => {
      toast("Turno adicionado.", "success");
      onDone();
    },
    onError: (e: unknown) => {
      toast((e as { detail?: string })?.detail ?? "Erro ao adicionar turno.", "error");
    },
  });

  return (
    <div className="border border-[var(--brand)] rounded p-1.5 space-y-1 bg-[var(--surface-2)]">
      <select className={inp} value={principalId} onChange={(e) => setPrincipalId(e.target.value)}>
        {members.map((m) => (
          <option key={m.principal_id} value={m.principal_id}>
            {m.principal_id}
          </option>
        ))}
      </select>
      <input type="datetime-local" className={inp} value={startsAt}
        onChange={(e) => setStartsAt(e.target.value)} />
      <input type="datetime-local" className={inp} value={endsAt}
        onChange={(e) => setEndsAt(e.target.value)} />
      <div className="flex gap-1">
        <Button size="sm" className="text-[10px] py-0 px-1.5 h-5"
          disabled={mut.isPending || !principalId}
          onClick={() => mut.mutate()}>
          {mut.isPending ? <Spinner className="w-2.5 h-2.5" /> : "OK"}
        </Button>
        <Button variant="secondary" size="sm" className="text-[10px] py-0 px-1.5 h-5"
          onClick={onCancel}>
          ✕
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function OncallPage({ tenantId }: { tenantId: string }) {
  const canOperate = useCanOperate();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [selectedScheduleId, setSelectedScheduleId] = useState<string | null>(null);
  const [weekOffset, setWeekOffset] = useState(0); // weeks from current week
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [deletingScheduleId, setDeletingScheduleId] = useState<string | null>(null);

  const schedulesQ = useQuery({
    queryKey: ["oncall-schedules", tenantId],
    queryFn: () => api.get<Schedule[]>("/api/v1/oncall/schedules"),
  });

  const membersQ = useQuery({
    queryKey: ["team-members", tenantId],
    queryFn: () => api.get<Member[]>("/api/v1/tenant/members"),
  });

  const currentQ = useQuery({
    queryKey: ["oncall-current", tenantId],
    queryFn: () => api.get<{ schedule_name: string; principal_id: string; display_name: string | null }[]>("/api/v1/oncall/current"),
    refetchInterval: 60_000,
  });

  const createMut = useMutation({
    mutationFn: () =>
      api.post<Schedule>("/api/v1/oncall/schedules", {
        name: newName.trim(),
        description: newDesc.trim() || undefined,
      }),
    onSuccess: (s) => {
      toast("Escala criada.", "success");
      qc.invalidateQueries({ queryKey: ["oncall-schedules"] });
      setCreating(false);
      setNewName("");
      setNewDesc("");
      setSelectedScheduleId(s.schedule_id);
    },
    onError: (e: unknown) => {
      toast((e as { detail?: string })?.detail ?? "Erro ao criar escala.", "error");
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/oncall/schedules/${id}`),
    onSuccess: () => {
      toast("Escala removida.", "success");
      qc.invalidateQueries({ queryKey: ["oncall-schedules"] });
      setDeletingScheduleId(null);
      if (selectedScheduleId === deletingScheduleId) setSelectedScheduleId(null);
    },
    onError: () => toast("Erro ao remover escala.", "error"),
  });

  const schedules = schedulesQ.data ?? [];
  const members = membersQ.data ?? [];
  const currentOncall = currentQ.data ?? [];
  const deletingSchedule = schedules.find((s) => s.schedule_id === deletingScheduleId);

  // Auto-select first schedule
  const activeScheduleId =
    selectedScheduleId ?? (schedules.length > 0 ? schedules[0].schedule_id : null);
  const activeSchedule = schedules.find((s) => s.schedule_id === activeScheduleId);

  const weekStart = useMemo(() => {
    const base = startOfWeek(new Date());
    return addDays(base, weekOffset * 7);
  }, [weekOffset]);

  const inp = "w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]";

  return (
    <div className="space-y-4">
      {deletingScheduleId && deletingSchedule && (
        <ConfirmModal
          title="Remover escala"
          description={`Remover "${deletingSchedule.name}" e todos os turnos? Esta ação não pode ser desfeita.`}
          confirmLabel="Remover"
          destructive
          isPending={deleteMut.isPending}
          onConfirm={() => deleteMut.mutate(deletingScheduleId)}
          onCancel={() => setDeletingScheduleId(null)}
        />
      )}

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-base font-semibold">Plantão (On-Call)</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Escalas de plantão por período — quem atender alertas fora do horário.
          </p>
        </div>
        {canOperate && !creating && (
          <Button size="sm" onClick={() => setCreating(true)}>Nova escala</Button>
        )}
      </div>

      {/* Who's on-call now */}
      {currentOncall.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {currentOncall.map((c) => (
            <div key={c.schedule_name}
              className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-[var(--green,#22c55e)] bg-[var(--green,#22c55e)]/10">
              <span className="w-2 h-2 rounded-full bg-[var(--green,#22c55e)] animate-pulse" />
              <span className="text-xs text-[var(--green,#22c55e)] font-medium">
                {c.display_name || c.principal_id}
              </span>
              <span className="text-[10px] text-[var(--text-muted)]">— {c.schedule_name}</span>
            </div>
          ))}
        </div>
      )}

      {/* New schedule form */}
      {canOperate && creating && (
        <Card className="p-4 space-y-3">
          <h3 className="text-sm font-medium">Nova escala de plantão</h3>
          <div className="space-y-1">
            <label className="text-xs text-[var(--text-muted)]">Nome</label>
            <input className={inp} value={newName} onChange={(e) => setNewName(e.target.value)}
              placeholder="ex: NOC On-Call" />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-[var(--text-muted)]">Descrição (opcional)</label>
            <input className={inp} value={newDesc} onChange={(e) => setNewDesc(e.target.value)}
              placeholder="ex: Plantão de madrugada e fins de semana" />
          </div>
          <div className="flex gap-2">
            <Button size="sm" disabled={createMut.isPending || !newName.trim()}
              onClick={() => createMut.mutate()}>
              {createMut.isPending && <Spinner className="w-3 h-3 mr-1" />}Criar
            </Button>
            <Button variant="secondary" size="sm" onClick={() => { setCreating(false); setNewName(""); }}>
              Cancelar
            </Button>
          </div>
        </Card>
      )}

      {/* Schedule selector tabs */}
      {schedulesQ.isLoading ? (
        <div className="flex justify-center py-8"><Spinner /></div>
      ) : schedules.length === 0 && !creating ? (
        <Card className="p-6 text-center">
          <p className="text-sm text-[var(--text-muted)]">Nenhuma escala configurada.</p>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            Crie uma escala para definir quem está de plantão a cada período.
          </p>
        </Card>
      ) : schedules.length > 0 && (
        <div className="space-y-4">
          {/* Tab bar */}
          <div className="flex items-center gap-1 border-b border-[var(--border)] pb-0 overflow-x-auto">
            {schedules.map((s) => (
              <button
                key={s.schedule_id}
                onClick={() => setSelectedScheduleId(s.schedule_id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-t border-b-2 transition-colors whitespace-nowrap ${
                  s.schedule_id === activeScheduleId
                    ? "border-[var(--brand)] text-[var(--text)] font-medium"
                    : "border-transparent text-[var(--text-muted)] hover:text-[var(--text)]"
                }`}
              >
                {s.name}
                {s.current_principal && (
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--green,#22c55e)]" />
                )}
              </button>
            ))}
            {canOperate && activeSchedule && (
              <button
                onClick={() => setDeletingScheduleId(activeSchedule.schedule_id)}
                className="ml-auto text-[10px] text-[var(--text-muted)] hover:text-[var(--red)] px-2 py-1"
              >
                remover escala
              </button>
            )}
          </div>

          {/* Calendar for selected schedule */}
          {activeScheduleId && (
            <Card className="p-4 space-y-3">
              {/* Week nav */}
              <div className="flex items-center justify-between">
                <button
                  onClick={() => setWeekOffset((w) => w - 1)}
                  className="text-xs text-[var(--text-muted)] hover:text-[var(--text)] px-2 py-1 rounded hover:bg-[var(--surface-2)]"
                >
                  ← Semana anterior
                </button>
                <div className="text-xs font-medium text-[var(--text)]">
                  {weekStart.toLocaleDateString("pt-BR", { day: "numeric", month: "long" })}
                  {" — "}
                  {addDays(weekStart, 6).toLocaleDateString("pt-BR", { day: "numeric", month: "long", year: "numeric" })}
                  {weekOffset === 0 && (
                    <span className="ml-2 text-[10px] text-[var(--brand)]">esta semana</span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {weekOffset !== 0 && (
                    <button
                      onClick={() => setWeekOffset(0)}
                      className="text-[10px] text-[var(--brand)] underline px-1"
                    >
                      hoje
                    </button>
                  )}
                  <button
                    onClick={() => setWeekOffset((w) => w + 1)}
                    className="text-xs text-[var(--text-muted)] hover:text-[var(--text)] px-2 py-1 rounded hover:bg-[var(--surface-2)]"
                  >
                    Próxima semana →
                  </button>
                </div>
              </div>

              <WeekCalendar
                scheduleId={activeScheduleId}
                tenantId={tenantId}
                canOperate={canOperate}
                members={members.filter((m) => m.state === "active")}
                weekStart={weekStart}
              />
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
