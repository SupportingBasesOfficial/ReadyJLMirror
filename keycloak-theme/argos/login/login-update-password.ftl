<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('password','password-confirm'); section>

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
    <h1 id="kc-page-title">Nova senha</h1>
    <p class="subtitle">Escolha uma senha segura para sua conta</p>

    <#if message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
      <div class="alert alert-${message.type}" role="alert">
        <#if message.type = 'error'>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        </#if>
        <span>${kcSanitize(message.summary)?no_esc}</span>
      </div>
    </#if>

    <form id="kc-passwd-update-form" action="${url.loginAction}" method="post">
      <input type="text" id="username" name="username" value="${username!''}" autocomplete="username" style="display:none"/>

      <div class="form-group">
        <label for="password-new">Nova senha</label>
        <div class="pf-v5-c-input-group">
          <input
            id="password-new"
            name="password-new"
            type="password"
            autocomplete="new-password"
            autofocus
            placeholder="••••••••"
          />
          <button class="pf-v5-c-button" type="button" aria-label="Mostrar senha"
            onclick="var p=document.getElementById('password-new');p.type=p.type==='password'?'text':'password';" tabindex="-1">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
            </svg>
          </button>
        </div>
        <#if messagesPerField.existsError('password')>
          <p style="font-size:11px;color:var(--danger);margin-top:4px">${kcSanitize(messagesPerField.get('password'))?no_esc}</p>
        </#if>
      </div>

      <div class="form-group">
        <label for="password-confirm">Confirmar senha</label>
        <div class="pf-v5-c-input-group">
          <input
            id="password-confirm"
            name="password-confirm"
            type="password"
            autocomplete="new-password"
            placeholder="••••••••"
          />
          <button class="pf-v5-c-button" type="button" aria-label="Mostrar confirmação"
            onclick="var p=document.getElementById('password-confirm');p.type=p.type==='password'?'text':'password';" tabindex="-1">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
            </svg>
          </button>
        </div>
        <#if messagesPerField.existsError('password-confirm')>
          <p style="font-size:11px;color:var(--danger);margin-top:4px">${kcSanitize(messagesPerField.get('password-confirm'))?no_esc}</p>
        </#if>
      </div>

      <#if isAppInitiatedAction??>
        <div style="display:flex;gap:8px;margin-bottom:16px">
          <input type="checkbox" id="logout-sessions" name="logout-sessions" value="on" style="accent-color:var(--brand)"/>
          <label for="logout-sessions" style="font-size:12px;color:var(--text-muted);cursor:pointer;margin:0">
            Encerrar outras sessões abertas
          </label>
        </div>
      </#if>

      <button type="submit" id="kc-login">
        Definir nova senha
      </button>
    </form>
  </#if>

</@layout.registrationLayout>
