<#import "template.ftl" as layout>
<@layout.registrationLayout; section>

  <#if section = "header">
    <div id="kc-logo">
      <a id="kc-logo-link" href="${properties.kcLogoLink!'#'}">
        <svg viewBox="0 0 100 100" width="40" height="40" style="border-radius:10px;flex-shrink:0">
          <rect width="100" height="100" rx="22" fill="#1b3f82"/>
          <line x1="16" y1="24" x2="44" y2="24" stroke="white" stroke-width="8.5" stroke-linecap="round"/>
          <path d="M 35,24 L 35,66 Q 35,80 23,80 Q 11,80 11,67" stroke="white" stroke-width="8.5" stroke-linecap="round" fill="none"/>
          <polyline points="55,24 55,78 83,78" stroke="white" stroke-width="8.5" stroke-linecap="round" fill="none"/>
        </svg>
        <div class="kc-logo-text">
          <span>Argos</span>
          <span>JL INFORMÁTICA</span>
        </div>
      </a>
    </div>
  </#if>

  <#if section = "form">
    <h1 id="kc-page-title">Ocorreu um erro</h1>
    <p class="subtitle">Não foi possível processar a solicitação</p>

    <#if message?has_content>
      <div class="alert alert-error" role="alert">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span>${kcSanitize(message.summary)?no_esc}</span>
      </div>
    </#if>

    <#if skipLink??>
      <p style="font-size:12px;color:var(--text-muted);text-align:center;margin-top:12px">
        ${msg("skipLink")}
      </p>
    <#else>
      <div style="text-align:center;margin-top:20px">
        <a href="${properties.kcLogoLink!'/'}" style="color:var(--brand);text-decoration:none;font-size:12px">
          ← Voltar para o início
        </a>
      </div>
    </#if>
  </#if>

</@layout.registrationLayout>
