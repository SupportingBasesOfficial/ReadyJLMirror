import { useState } from "react";
import { HelpCircle, X } from "lucide-react";

export interface PageInfo {
  title: string;
  description: string;
  permissions?: string[];
  actions?: string[];
  notes?: string[];
}

const PAGE_INFO: Record<string, PageInfo> = {
  noc: {
    title: "NOC Dashboard",
    description: "Visão operacional em tempo real com stream SSE. Exibe alertas ativos, estado de dispositivos e widgets customizáveis. Templates salvos em localStorage por tenant.",
    permissions: ["qualquer autenticado"],
    actions: ["Arrastar/reorganizar widgets", "Criar templates", "Modo TV (fullscreen)"],
  },
  alerts: {
    title: "Alertas",
    description: "Lista de alertas ativos e resolvidos vindos do Alertmanager e das fontes de monitoramento. Suporta silenciar, criar incidente, ver histórico.",
    permissions: ["alerting:read"],
    actions: ["Silenciar alerta", "Criar incidente a partir de alerta", "Ver histórico"],
  },
  incidents: {
    title: "Incidentes",
    description: "Gerenciamento de incidentes (ITSM G10). Incidentes são criados manualmente a partir de alertas via POST /alerting/alerts/{id}/incidents. Fluxo: open → in_progress → resolved → closed.",
    permissions: ["alerting:read"],
    actions: ["Criar incidente de alerta", "Atualizar estado", "Vincular mudança"],
    notes: ["Incidentes não são criados automaticamente — devem ser abertos manualmente a partir de um alerta ativo."],
  },
  policies: {
    title: "Políticas de Alerta",
    description: "Regras de roteamento e escalonamento de alertas. Define qual canal recebe qual tipo de alerta, com condições, prioridades e janelas de manutenção.",
    permissions: ["alerting:operate"],
    actions: ["Criar política", "Ativar/desativar", "Testar política"],
  },
  changes: {
    title: "Mudanças (ITSM)",
    description: "Registro de Mudanças (RFC) com fluxo de aprovação. Estados: draft → review → approved → scheduled → implementing → complete (ou cancelled). Integração com G10 ITSM.",
    permissions: ["alerting:read"],
    actions: ["Criar RFC", "Aprovar/rejeitar", "Executar implementação"],
  },
  monitoring: {
    title: "Monitoramento",
    description: "Estado atual de métricas de todas as fontes configuradas (Zabbix). Mostra estado de escopo, evidência e última observação por recurso.",
    permissions: ["monitoring:read"],
    actions: ["Ver detalhes de métrica", "Filtrar por estado", "Ver histórico"],
  },
  inventory: {
    title: "Inventário",
    description: "Catálogo de dispositivos descobertos pelas fontes de monitoramento. Inclui dados de hardware, SO, interfaces de rede e informações de contato/localização vindas do Zabbix.",
    permissions: ["monitoring:read"],
    actions: ["Ver detalhes do dispositivo", "Ver localização/contato", "Ver métricas associadas"],
  },
  sla: {
    title: "SLA",
    description: "Definição e acompanhamento de Acordos de Nível de Serviço. Calcula uptime e violações com base nos dados de monitoramento.",
    permissions: ["alerting:read"],
    actions: ["Criar SLA", "Ver histórico de violações", "Exportar relatório"],
  },
  automation: {
    title: "Automação",
    description: "Regras de automação que executam ações em resposta a eventos do sistema. Integrada com G11 Incident Response.",
    permissions: ["alerting:operate"],
    actions: ["Criar automação", "Ativar/desativar", "Ver histórico de execução"],
  },
  reports: {
    title: "Relatórios",
    description: "Geração de relatórios periódicos e sob demanda com dados de monitoramento, alertas e SLA.",
    permissions: ["observability:read"],
    actions: ["Gerar relatório", "Exportar PDF/CSV", "Agendar entrega"],
  },
  aiops: {
    title: "AIOps",
    description: "Análise inteligente com Claude Sonnet. Correlaciona alertas, sugere causas raiz e recomenda ações. Usa o ledger de aprendizado adversarial do G12.",
    permissions: ["observability:read"],
    actions: ["Consultar análise", "Ver correlações", "Exportar insights"],
  },
  executive: {
    title: "Dashboard Executivo",
    description: "Visão agregada de KPIs globais da plataforma para gestão. Exibe alertas ativos/resolvidos, incidentes por estado, mudanças em curso, saúde das fontes de monitoramento e violações de SLA nos últimos 30 dias. Admins de plataforma veem dados cross-tenant; admins de tenant veem apenas seu escopo.",
    permissions: ["tenant:admin", "platform_admin"],
    actions: [
      "Ver alertas ativos e resolvidos nas últimas 24 h",
      "Acompanhar incidentes por estado",
      "Monitorar mudanças em andamento",
      "Ver saúde das fontes de monitoramento",
      "Consultar violações de SLA (30 dias)",
      "Top tenants por volume de alertas (platform_admin)",
    ],
    notes: [
      "Dados atualizados a cada 60 segundos automaticamente.",
      "Platform admins veem agregação cross-tenant; tenant admins veem apenas o próprio tenant.",
    ],
  },
  finops: {
    title: "FinOps",
    description: "Visibilidade de custos de infraestrutura e uso de recursos. Consolida dados de billing por tenant, organização e contrato.",
    permissions: ["tenant:read"],
    actions: ["Ver custos por período", "Comparar tenants", "Exportar"],
  },
  apm: {
    title: "APM — Performance de API",
    description: "Monitor de performance de API. Exibe latência p50/p95/p99, taxa de erro e volume de requisições por endpoint nas últimas 24 h. Dados coletados pelo APMMiddleware a cada chamada à API.",
    permissions: ["tenant:read"],
    actions: [
      "Ver latência percentílica por endpoint",
      "Identificar endpoints lentos (p95 > 500 ms)",
      "Monitorar taxa de erro 5xx",
      "Ver volume de requisições por hora",
    ],
    notes: [
      "Dados aparecem após as primeiras chamadas à API autenticadas.",
      "Registros mantidos por 7 dias.",
      "Platform admins veem dados cross-tenant.",
    ],
  },
  platform: {
    title: "Plataforma",
    description: "Configurações da plataforma de monitoramento: fontes de dados, credenciais, integrações e configurações avançadas.",
    permissions: ["tenant:admin"],
    actions: ["Gerenciar fontes", "Configurar credenciais", "Webhook settings"],
  },
  audit: {
    title: "Auditoria",
    description: "Log imutável de todos os eventos do sistema. Registros de autenticação, alterações de configuração, ações de usuários e eventos de segurança.",
    permissions: ["audit:read"],
    actions: ["Filtrar por tipo/data/ator", "Exportar log"],
  },
  maintenance: {
    title: "Janelas de Manutenção",
    description: "Períodos programados onde alertas são suprimidos ou tratados diferentemente. Permite planejar manutenções sem poluir o dashboard de alertas.",
    permissions: ["alerting:operate"],
    actions: ["Criar janela", "Editar recorrência", "Cancelar manutenção"],
  },
  channels: {
    title: "Canais de Notificação",
    description: "Configuração de canais de entrega de notificações: email, Slack, WhatsApp, webhook. Cada canal tem sua própria fila de dispatch com retry.",
    permissions: ["alerting:operate"],
    actions: ["Adicionar canal", "Testar envio", "Ver histórico de entregas"],
  },
  escalation: {
    title: "Escalonamento",
    description: "Políticas de escalonamento que definem o que acontece quando um alerta não é tratado dentro de um tempo limite.",
    permissions: ["alerting:operate"],
    actions: ["Criar política de escalonamento", "Definir níveis", "Configurar notificados"],
  },
  team: {
    title: "Equipe",
    description: "Gerenciamento de membros da equipe, grupos e plantões. Vincula pessoas a responsabilidades de monitoramento.",
    permissions: ["tenant:read"],
    actions: ["Adicionar membro", "Criar grupo", "Configurar plantão"],
  },
  apikeys: {
    title: "Chaves de API",
    description: "Gerenciamento de chaves de API para integrações externas. Rate limit: 60 req/min por chave (sliding window no PostgreSQL).",
    permissions: ["tenant:admin"],
    actions: ["Criar chave", "Revogar chave", "Ver log de uso"],
  },
  msp: {
    title: "MSP Overview",
    description: "Visão consolidada de todos os tenants gerenciados pelo MSP. Permite navegar entre tenants e ver saúde global.",
    permissions: ["tenant:admin com delegação MSP"],
    actions: ["Selecionar tenant", "Ver alertas por cliente", "Gerenciar delegações"],
  },
  kb: {
    title: "Base de Conhecimento",
    description: "Artigos técnicos, runbooks e documentação interna. Suporta categorias, busca full-text e links para incidentes.",
    permissions: ["tenant:read"],
    actions: ["Criar artigo", "Buscar", "Vincular a incidente"],
  },
  teia: {
    title: "Teia de Relacionamentos",
    description: "Visualização hierárquica de Organizações → Tenants → Usuários. Visão administrativa do modelo de identidade.",
    permissions: ["platform_admin"],
    actions: ["Navegar hierarquia", "Ver usuários por tenant"],
  },
  users: {
    title: "Usuários",
    description: "Gerenciamento de usuários do tenant: convidar, editar dados (nome/email/papel), ativar/desativar, redefinir senha e remover.",
    permissions: ["tenant:admin"],
    actions: ["Convidar usuário", "Editar nome/email", "Alterar papel", "Redefinir senha", "Desativar/remover"],
  },
  "platform-admin": {
    title: "Administração da Plataforma",
    description: "Painel exclusivo para platform_admin. Gerencia organizações (Plataforma / MSP / Cliente), tenants, relacionamentos MSP, delegated grants, contratos, usuários cross-tenant e saúde global da plataforma.",
    permissions: ["platform_admin (kind = platform_admin_principal)"],
    actions: [
      "Criar organização com tipo (Plataforma / MSP / Cliente)",
      "Criar tenant e vincular a organização",
      "Ver org 360: workspaces, relacionamentos, grants ativos, membros",
      "Encerrar relacionamento MSP ativo",
      "Transferir cliente de um prestador de serviço para outro (service-provider-transfer)",
      "Criar e revogar delegated grants",
      "Wizard de onboarding de cliente MSP",
      "Buscar usuários cross-tenant com contexto de tenant/papel",
      "Saúde da plataforma com uso agrupado por organização",
      "Gerenciar contratos e entitlements",
      "Criar tokens de TV Mode por tenant",
    ],
    notes: [
      "org_kind distingue o papel de cada organização no modelo: platform_operator, msp ou client.",
      "Delegated grants exigem um relacionamento MSP ativo como pré-requisito (fail-closed).",
    ],
  },
  alertmanager: {
    title: "Alertmanager",
    description: "Ingestão de alertas via Prometheus Alertmanager webhook. Gerencia tokens HMAC para autenticação e mostra alertas ingeridos.",
    permissions: ["alerting:operate"],
    actions: ["Criar token HMAC", "Ver alertas ingeridos", "Testar webhook"],
  },
  infra: {
    title: "Governança de Infra",
    description: "Visão de ativos de infraestrutura e governança: inventário de ativos, compliance e gestão de ciclo de vida.",
    permissions: ["observability:read"],
    actions: ["Ver ativos", "Criar grupo de recursos", "Relatório de compliance"],
  },
  synthetic: {
    title: "Monitoramento Sintético",
    description: "Testes ativos de disponibilidade: HTTP checks, ping, DNS. Executados periodicamente para detectar problemas antes dos usuários.",
    permissions: ["monitoring:read"],
    actions: ["Criar check", "Ver histórico de resultados", "Configurar alertas"],
  },
  oncall: {
    title: "Plantão",
    description: "Gestão de escalas de plantão. Integrado com canais de notificação para roteamento automático ao plantonista ativo.",
    permissions: ["tenant:read"],
    actions: ["Criar escala", "Trocar turno", "Ver histórico de plantão"],
  },
  custom_dashboard: {
    title: "Dashboard Customizado",
    description: "Painéis personalizáveis com widgets configuráveis. Layouts salvos por usuário no servidor (g1.user_layout).",
    permissions: ["tenant:read"],
    actions: ["Adicionar widget", "Reorganizar layout", "Salvar visualização"],
  },
  bugs: {
    title: "Bug Reports",
    description: "Gerenciamento de bugs reportados pelos usuários via botão 'Bug' no header. Permite filtrar por status, ver detalhes e atualizar status/resolução.",
    permissions: ["tenant:admin"],
    actions: ["Filtrar por status", "Ver detalhes e descrição", "Atualizar status", "Registrar resolução"],
  },
  status_page: {
    title: "Status Page",
    description: "Página pública de status de serviços. Mostra estado atual e histórico de incidentes para usuários externos.",
    permissions: ["tenant:admin"],
    actions: ["Criar página de status", "Publicar incidente", "Gerenciar componentes"],
  },
  "tenant-settings": {
    title: "Configurações do Tenant",
    description: "Configure identidade visual, servidor de e-mail SMTP e preferências operacionais do tenant.",
    permissions: ["tenant:admin"],
    actions: [
      "Personalizar nome, cor e logo do tenant (Branding)",
      "Configurar servidor SMTP e enviar e-mail de teste",
      "Ativar/desativar notificações por tipo (alertas, incidentes, SLA)",
      "Definir fuso horário e formato de data",
    ],
    notes: [
      "A senha SMTP é armazenada criptografada e exibida mascarada.",
      "Branding é salvo em g1.tenant_branding; SMTP e preferências em g1.tenant_settings.",
    ],
  },
  "account-security": {
    title: "Segurança da Conta",
    description: "Gerencie a segurança da sua conta: sessões ativas, autenticação de dois fatores (TOTP) e direitos de privacidade (LGPD).",
    permissions: ["qualquer autenticado"],
    actions: [
      "Ver e revogar sessões ativas",
      "Configurar autenticação de dois fatores (TOTP/RFC 6238)",
      "Exportar dados pessoais (LGPD art. 18)",
      "Solicitar exclusão de conta (LGPD art. 18)",
    ],
    notes: [
      "A solicitação de exclusão é processada manualmente em até 30 dias. Sessão atual não pode ser revogada.",
    ],
  },
  "feature-flags": {
    title: "Feature Flags",
    description: "Controle quais módulos opcionais estão ativos para este tenant. Alterações têm efeito imediato para todos os usuários.",
    permissions: ["tenant:admin"],
    actions: [
      "Ativar ou desativar módulos individualmente",
      "Restaurar flags padrão para flags faltantes",
      "Ver quem atualizou cada flag por último",
    ],
    notes: [
      "Flags beta estão em desenvolvimento ativo e podem ser instáveis. Ative com cautela em produção.",
    ],
  },
  "config-drift": {
    title: "Detecção de Desvio de Configuração",
    description: "Compare configurações atuais dos dispositivos contra valores esperados (baselines). Gera eventos de desvio auditáveis com fluxo de reconhecimento e resolução.",
    permissions: ["tenant:read (leitura)", "monitoring:operate (scan, criar baselines)"],
    actions: [
      "Executar scan manual de desvios",
      "Criar e remover baselines de configuração",
      "Reconhecer eventos de desvio abertos",
      "Marcar eventos como resolvidos",
      "Filtrar eventos por estado (aberto / reconhecido / resolvido)",
    ],
    notes: [
      "Baselines são comparados contra metric_observation (item_key = config_key). Sem dados observados, o baseline é ignorado no scan.",
      "O scan é idempotente: não cria evento duplicado se já existe um 'open' para o mesmo baseline.",
    ],
  },
};

interface Props {
  screenId: string;
}

export function PageInfoButton({ screenId }: Props) {
  const [open, setOpen] = useState(false);
  const info = PAGE_INFO[screenId];
  if (!info) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Informações desta tela"
        className="flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--brand,#6366f1)] hover:border-[var(--brand,#6366f1)] transition-colors"
      >
        <HelpCircle size={13} />
        <span className="hidden sm:inline">Info</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <div className="bg-[var(--surface-1)] border border-[var(--border)] rounded-t-xl sm:rounded-xl shadow-xl w-full sm:max-w-sm mx-0 sm:mx-4 p-5 space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-mono text-[var(--text-muted)] mb-0.5">{screenId}</p>
                <h3 className="text-sm font-semibold">{info.title}</h3>
              </div>
              <button onClick={() => setOpen(false)} className="text-[var(--text-muted)] hover:text-[var(--text)] ml-3 flex-shrink-0">
                <X size={15} />
              </button>
            </div>

            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{info.description}</p>

            {info.permissions && (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-1.5">Permissões necessárias</p>
                <div className="flex flex-wrap gap-1">
                  {info.permissions.map((p) => (
                    <span key={p} className="text-[11px] px-2 py-0.5 rounded bg-[var(--surface-2)] border border-[var(--border)] font-mono">
                      {p}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {info.actions && (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-1.5">Ações disponíveis</p>
                <ul className="space-y-1">
                  {info.actions.map((a) => (
                    <li key={a} className="text-xs text-[var(--text-secondary)] flex items-start gap-1.5">
                      <span className="text-[var(--brand,#6366f1)] mt-0.5 flex-shrink-0">·</span>
                      {a}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {info.notes && (
              <div className="rounded-lg bg-[var(--surface-2)] border border-[var(--border)] p-3">
                {info.notes.map((n, i) => (
                  <p key={i} className="text-[11px] text-[var(--text-muted)] leading-relaxed">{n}</p>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
