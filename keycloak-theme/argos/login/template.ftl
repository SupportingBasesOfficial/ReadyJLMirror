<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Argos · JL Informática</title>
  <link rel="stylesheet" href="${url.resourcesPath}/css/login.css"/>
</head>
<body>
  <div class="kc-page">
    <div class="kc-card">
      <#nested "header">
      <#nested "form">
      <#if displayInfo><#nested "info"></#if>
    </div>
  </div>
</body>
</html>
</#macro>
