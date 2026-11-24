# Argos / ReadyJLMirror — Regras de Trabalho

## Autorização de merge

**Todo merge requer autorização explícita de Mauricio.** CI verde ≠ mudança aprovada.
Nunca usar `--no-verify`. Nunca fazer merge sem confirmação direta na conversa.

## Checklist obrigatório antes de qualquer merge

### Nova tabela SQL
- [ ] `ENABLE ROW LEVEL SECURITY` presente na migration
- [ ] `FORCE ROW LEVEL SECURITY` presente na migration
- [ ] Política RLS criada (`CREATE POLICY`) para `jlmirror_app`
- [ ] Se excepcionalmente sem RLS: justificativa formal documentada e aprovada

### Novo endpoint (router)
- [ ] `tenant_id` vem do contexto autenticado (BFF context / middleware), **nunca do request body**
- [ ] Nenhum fallback hardcoded: sem `'dev-tenant'`, sem `'dev-operator'`, sem `'dev-*'`
- [ ] Query de leitura com `AND tenant_id = %s` (defense-in-depth além do RLS)
- [ ] Query de escrita com `AND tenant_id = %s` em UPDATE/DELETE

### Nova função SQL chamada por código Python
- [ ] Função existe no SQL antes de fazer deploy (grep em `sql/` antes de `api/`)

### Qualquer mudança em código de produção
- [ ] Sem strings hardcoded de ambiente: `'dev-tenant'`, `'dev-operator'`, `DEV_AUTH_BYPASS`
- [ ] Se remover `DEV_AUTH_BYPASS`: autorização explícita de Mauricio para esse step

## Anti-padrões — grep antes de mergear

```
'dev-tenant'          → fallback hardcoded de tenant
'dev-operator'        → fallback hardcoded de principal
tenant_id.*body       → tenant_id vindo do request body
key_pem.*TEXT         → chave privada em texto plano
password.*TEXT        → senha em texto plano
```

Executar antes de qualquer PR para produção:
```bash
grep -rn "dev-tenant\|dev-operator" api/routers/
grep -rn "body\[.tenant_id.\]\|body\.get.*tenant_id" api/routers/
```

## Invariantes permanentes

1. **AIOps nunca cria nem resolve Alertas.** `aiops.py` não escreve em `alerting.alert`.
2. **BFF é fronteira de segurança** — não duplicação. Não remover sem substituto formal.
3. **`credential_binding_ref` ≠ segredo.** NUNCA rotacionar `cred-binding-1` ou `cred-zbx-prod-1` sem prova completa de rotação end-to-end.
4. **`DEV_AUTH_BYPASS=true` em dev** até todas as features concluídas. Nunca setar `false` em dev sem autorização de Mauricio.
5. **`EGRESS_ALLOW_ALL_HOSTS=true` NUNCA em produção.**
6. **G12–G15**: requer PO unlock formal (Record #68 cobre G12). G13–G15 ainda sem autorização formal.
7. **`audit.audit_event` é append-only.** Nunca adicionar UPDATE/DELETE para `jlmirror_app` ou `jlmirror_worker`.

## Exceção arquitetural conhecida

**Schema `g1` não tem RLS** — isolamento via tenant-scoped connection (`db_tenant_connection(tenant_id)`).
Esta exceção é deliberada e está documentada. Não é um bug. Não "corrigir" sem prova formal de que a migração para RLS é segura e sem impacto no isolamento existente.

## Referências

- Decisões arquiteturais completas: `memory/project_architecture_decisions.md` (JLMIRROR-PROD)
- Mapa vivo do sistema: `docs/SYSTEM_MAP.md` (JLMIRROR-PROD)
- Audit completo 2026-11-23: `memory/project_audit_completo.md` (JLMIRROR-PROD)
- Sprint 1 (bloqueante para piloto): ver `project_audit_completo.md` → PLANO EM 3 SPRINTS
