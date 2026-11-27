<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('username'); section>

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
    <h1 id="kc-page-title">Redefinir senha</h1>
    <p class="subtitle">Informe seu e-mail e enviaremos as instruções</p>

    <#if message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
      <div class="alert alert-${message.type}" role="alert">
        <#if message.type = 'error'>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <#elseif message.type = 'success'>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        </#if>
        <span>${kcSanitize(message.summary)?no_esc}</span>
      </div>
    </#if>

    <form id="kc-reset-password-form" action="${url.loginAction}" method="post">
      <div class="form-group">
        <label for="username">
          <#if !realm.loginWithEmailAllowed>Usuário
          <#elseif !realm.registrationEmailAsUsername>Usuário ou e-mail
          <#else>E-mail</#if>
        </label>
        <input
          id="username"
          name="username"
          type="text"
          autocomplete="username"
          value="${auth.attemptedUsername!''}"
          autofocus
          placeholder="<#if !realm.loginWithEmailAllowed>seu usuário<#elseif !realm.registrationEmailAsUsername>usuário ou e-mail<#else>seu@email.com</#if>"
        />
        <#if messagesPerField.existsError('username')>
          <p style="font-size:11px;color:var(--danger);margin-top:4px">${kcSanitize(messagesPerField.get('username'))?no_esc}</p>
        </#if>
      </div>

      <button type="submit" id="kc-login">
        Enviar instruções
      </button>
    </form>

    <div id="kc-registration" style="margin-top:20px">
      <a href="${url.loginUrl}" style="color:var(--brand);text-decoration:none;font-size:12px">
        ← Voltar para o login
      </a>
    </div>
  </#if>

</@layout.registrationLayout>
