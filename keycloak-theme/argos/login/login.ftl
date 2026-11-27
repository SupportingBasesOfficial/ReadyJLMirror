<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('username','password') displayInfo=realm.password && realm.registrationAllowed && !registrationDisabled??; section>

  <#if section = "header">
    <!-- Logo JL / Argos -->
    <div id="kc-logo">
      <a id="kc-logo-link" href="${properties.kcLogoLink!'#'}">
        <!-- JL Square Logo -->
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
    <h1 id="kc-page-title">Acesse sua conta</h1>
    <p class="subtitle">Monitoramento e operações de TI</p>

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

    <form id="kc-form-login" action="${url.loginAction}" method="post">

      <#if !usernameHidden??>
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
            value="${login.username!''}"
            autofocus
            <#if usernameEditDisabled??>disabled</#if>
            placeholder="<#if !realm.loginWithEmailAllowed>seu usuário<#elseif !realm.registrationEmailAsUsername>usuário ou e-mail<#else>seu@email.com</#if>"
          />
          <#if messagesPerField.existsError('username')>
            <p style="font-size:11px;color:var(--danger);margin-top:4px">${kcSanitize(messagesPerField.get('username'))?no_esc}</p>
          </#if>
        </div>
      </#if>

      <div class="form-group">
        <label for="password">Senha</label>
        <div class="pf-v5-c-input-group">
          <input
            id="password"
            name="password"
            type="password"
            autocomplete="current-password"
            placeholder="••••••••"
          />
          <button
            class="pf-v5-c-button"
            type="button"
            aria-label="Mostrar senha"
            onclick="var p=document.getElementById('password');p.type=p.type==='password'?'text':'password';"
            tabindex="-1"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </button>
        </div>
        <#if messagesPerField.existsError('password')>
          <p style="font-size:11px;color:var(--danger);margin-top:4px">${kcSanitize(messagesPerField.get('password'))?no_esc}</p>
        </#if>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:8px">
        <#if realm.rememberMe && !usernameHidden??>
          <div class="checkbox">
            <input id="rememberMe" name="rememberMe" type="checkbox" <#if login.rememberMe??>checked</#if>/>
            <label for="rememberMe">Lembrar de mim</label>
          </div>
        <#else>
          <span></span>
        </#if>

        <#if realm.resetPasswordAllowed>
          <a id="kc-forgot-password" href="${url.loginResetCredentialsUrl}" style="font-size:12px;color:var(--brand);text-decoration:none">
            Esqueci minha senha
          </a>
        </#if>
      </div>

      <input type="hidden" id="id-hidden-input" name="credentialId" <#if auth.selectedCredential?has_content>value="${auth.selectedCredential}"</#if>/>

      <button type="submit" id="kc-login" name="login">
        Entrar
      </button>
    </form>

    <#if realm.password && social.providers??>
      <div id="social-providers-section">
        <h5>ou continue com</h5>
        <ul style="list-style:none;padding:0">
          <#list social.providers as p>
            <li>
              <a href="${p.loginUrl}" class="social-link">
                <span>${p.displayName!''}</span>
              </a>
            </li>
          </#list>
        </ul>
      </div>
    </#if>

  </#if>

  <#if section = "info">
    <#if realm.password && realm.registrationAllowed && !registrationDisabled??>
      <div id="kc-registration">
        Não tem conta? <a href="${url.registrationUrl}">Criar conta</a>
      </div>
    </#if>
  </#if>

</@layout.registrationLayout>
