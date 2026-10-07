# Changelog — JLMirror (ReadyJLMirror)

Mudanças notáveis do produto, organizadas por milestone. Mais recentes primeiro.
Formato baseado em [Keep a Changelog](https://keepachangelog.com/).

---

## [Não lançado] — feat/g11-incident-response

### Adicionado
- **G11 Incident Response** — canais de notificação, scripts de remediação, políticas de escalonamento e execução controlada de playbooks
- **G12 AIOps** — parâmetro `include_dismissed` no endpoint de findings; campo `recommended_action` exibido na UI
- **G23** — coluna `escalation_policy_id` em `alert_policy_version`; migração `sql/alerting/006_g23_link_alert_policy.sql`
- **G32 Automation Runtime** — página de automação com scripts, runs e logs de execução
- **G33 Scheduled Reports** — templates, schedules, subscribers, histórico de entregas; endpoint `POST /templates/{id}/trigger`
- **G34 Alertmanager Source** — integração com Alertmanager como fonte de alertas
- **G35 Infrastructure Governance** — tracker de certificados TLS, inventário de assets, endpoint `POST /certs/{id}/recheck`
- **G36 Knowledge Base** — artigos, busca, deep-link `?article=<id>`, sanitização XSS via DOMPurify
- **Platform** — `GET /api/v1/platform/health`, `POST /api/v1/platform/tenants`
- **Tenant** — `PATCH /api/v1/tenant/members/{id}` para atualização de role
- **Monitoring** — aliases `source_id`, `state`, `provider` em `SourceDetailResponse`; endpoint `POST /sources/{id}/recheck`

### Corrigido
- Navegação SPA: substituição de `window.history.pushState + PopStateEvent` por `useNavigate` em todas as páginas
- `AIOpsPage`, `IncidentResponsePage`, `AlertDetail`, `MSPOverviewPage`, `NOCDashboard`, `SLAPage` — todos usando React Router corretamente
- `KnowledgeBasePage` — XSS via `marked()` sem sanitização; corrigido com DOMPurify
- `AuditPage`, `AutomationPage` — chaves de Fragment no mapeamento de linhas expansíveis
- `changes.py` — coluna `description` ausente no SELECT de `list_changes`
- `alerting.py` — campos `description`, `problem_event_ids`, `ack_history` agora retornados em `GET /alerts/{id}`
- `TeamPage` — URL de atualização de role corrigida: `/authority/memberships/` → `/tenant/members/`
- `PlatformAdminPage` — payload de criação de tenant alinhado com o backend (`tenant_id`, `display_name`, `organization_id`)
- `NOCDashboard` — parâmetro `tenant_id` removido de `/maintenance/windows` (derivado do JWT no backend)
- `IncidentResponsePage` — empty state de ScriptPicker com link para `/automation`; validação de shape em `fetchEvents`
- `EscalationPage` — campo `linked_alert_policy_id` adicionado à interface e exibido na tabela

---

## [M5 — Hardening de Segurança] — 2026-10-03 / 2026-10-05

### Segurança
- **OpenBao** — porta 8200 fechada para o host; unseal key movida para fora do git (`~/.secrets/openbao_unseal.key`)
- Endpoints de rotação/revogação de credencial de monitoring source endurecidos

### Corrigido
- Logout: falha de CSRF e segredo de cliente Keycloak
- Worker: healthcheck lendo `db_password` de arquivo de secret
- Monitoring repo: 4 bugs de corretude e performance
- Backend/DB: conjunto de issues identificados em análise profunda
- Shell: URL do badge de mudanças (prefixo ITSM)
- Inventory: guard contra valores de métrica primitivos em `DeviceDetail`

---

## [M4 — Platform & Resiliência] — 2026-09-22 / 2026-09-23

### Adicionado
- **UI Monitoring** — source detail com abas (Overview / Hosts / Problems / Metrics / Alerts / Ops), filtros ao vivo, group picker, op watcher por detalhe, expansão persistente na tabela de ops
- **OpenBao runtime** — resolução de credenciais em tempo de execução; write-through para o secrets store
- **Backup & PITR** — WAL archiving, base backups com retenção, rehearsal de restore em DB isolado
- **Prometheus** — regras de alerta, endpoint `/metrics`, scrape stack de desenvolvimento
- **Grafana** — provisionado no compose (perfil observability)
- **DLQ Recovery** — redrive de outbox em quarentena; visibilidade no inbox
- **Reconciliation worker** — reaper de ops expiradas + pipeline de reconciliação contínua
- **Platform** — service-provider transfer (contrato §13); display principals (§9); commercial attribution (§10–12); org 360; delegated grants fail-closed
- **Custom roles** — primeiro cidadão (contrato §8); criação, aposentadoria, atribuição
- PITR: runbook de restore documentado e verificado

### Corrigido
- Scheduler: dead-end para sources indisponíveis
- Outbox webhook: mTLS e comparação de metadados em re-sync de problemas
- Pipeline real-scale: paginação de histórico, skip de itens nunca amostrados, projeção de valores canônicos
- Zabbix 7.x: renomeação de hostgroup em `host.get` sub-select
- Shell flicker: revalidação de `app.js` e reload silencioso

---

## [M3 — Operações & Notificações] — 2026-09-20 / 2026-09-21

### Adicionado
- **G7 Alert Policy Lifecycle** — motor de avaliação real de políticas de alerta
- **G8 Human Operations** — assign, acknowledge, requisito de visibilidade, recibo de operação
- **G9 Notification Delivery** — intent de WhatsApp, outbox, callbacks HMAC; janela de replay; retry com metadados
- **G10 ITSM Incidents** — modelo canônico `g10.itsm-incident@1`, sync outbox, lease, retry
- **Shell admin** — membros do tenant, custom roles, visão de plataforma
- **RBAC** — permissões efetivas projetadas na shell; fail-closed grants; tenant admin; org 360

### Corrigido
- OIDC: troca de token apontando para BFF em vez de Keycloak
- G9: binding de tenant em callbacks; boundary secrets fail closed
- Shell: escape de todos os valores fornecidos pelo servidor em `innerHTML`
- Worker: reconexão em perda de conexão com banco
- Migrations: reorganização de G8/G9 para ordenação lexical correta

---

## [M2 — Alerting Core] — 2026-09-18

### Adicionado
- **Alert core model** — `alerting.alert`, transições, publication bridge
- **G6 Transport Consumer** — bridge Monitoring→Alerting com dedup de inbox
- **Audit trail** — imutável e durável (SEC-AUD)
- **DNS pinning** — resolve-once, connect-to-IP (fix de TOCTOU)
- **Egress** — admission fail-closed com allowlist obrigatória + DNS screen
- **Ops** — worker heartbeat, parity de readiness, chaos matrix, SLO probe, API healthcheck
- DLQ surface — visibilidade de sync operations com falha; requeue por operador
- Shell: view de alertas no source detail

### Corrigido
- RLS battery em DB fresco
- Bootstrap de worker em ordering de migrations
- Role do worker + ordenação de migrations em clone limpo

---

## [M1 — Fundação] — 2026-09-16 / 2026-09-17

### Adicionado
- **Stack inicial** — FastAPI (api/), BFF OIDC (bff/), workers, TimescaleDB, Keycloak, Docker Compose
- **G1 Identity & Tenant** — OIDC BFF, sessões, RLS, CSRF, shell protegida
- **Monitoring Wave 4** — sources → inventário → métricas → problemas → health → outbox de publicação
- **Security** — mTLS BFF↔API, OpenBao dev backend, mounted-file secrets, `PROVIDER_CA_FILE`
- **Telemetry** — correlation IDs, logs JSON estruturados (ADR-014)
- Shell: onboarding de source com provider token (write-through), discovery de grupos
- Provider: adaptador Zabbix real + E2E harness com fake-zabbix
- Tenant RLS: `FORCE ROW LEVEL SECURITY` em todas as tabelas de monitoring
- mTLS: least-privilege grants para `jlmirror_app`

### Corrigido
- Windows: seletor de event loop para compatibilidade com psycopg async pool
