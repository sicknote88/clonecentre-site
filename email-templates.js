const BLUE = '#2e9bff';
const INK = '#020406';
const PANEL = '#071018';
const BORDER = '#1d3448';
const TEXT = '#eef6ff';
const MUTED = '#9aaaba';

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  })[character]);
}

function safeUrl(value = '') {
  const candidate = String(value).trim();
  if (/^https:\/\//i.test(candidate) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(?:\/|$)/i.test(candidate) || /^mailto:/i.test(candidate)) return escapeHtml(candidate);
  return '#';
}

export function emailButton(url, label, { secondary = false } = {}) {
  const background = secondary ? '#071018' : BLUE;
  const color = secondary ? BLUE : '#00101d';
  const border = secondary ? BLUE : BLUE;
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 12px">
    <tr>
      <td bgcolor="${background}" style="border:1px solid ${border};mso-padding-alt:14px 20px">
        <a href="${safeUrl(url)}" style="display:inline-block;padding:14px 20px;color:${color};font-family:'Courier New',Courier,monospace;font-size:13px;font-weight:700;letter-spacing:1.2px;line-height:1;text-decoration:none">${escapeHtml(label)} &nbsp;&gt;</a>
      </td>
    </tr>
  </table>`;
}

export function emailDetailTable(rows = []) {
  const cells = rows.map(([label, value]) => `<tr>
    <td class="detail-label" valign="top" style="width:145px;padding:11px 12px;border-bottom:1px solid ${BORDER};color:#6f879a;font-family:'Courier New',Courier,monospace;font-size:10px;letter-spacing:1px;text-transform:uppercase">${escapeHtml(label)}</td>
    <td valign="top" style="padding:11px 12px;border-bottom:1px solid ${BORDER};color:${TEXT};font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;word-break:break-word">${escapeHtml(value || 'Not provided')}</td>
  </tr>`).join('');
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:20px 0;border:1px solid ${BORDER};background:${PANEL}">${cells}</table>`;
}

export function emailCallout(label, value, copy = '') {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:20px 0;background:#061827;border-left:3px solid ${BLUE}">
    <tr><td style="padding:16px 18px">
      <div style="margin:0 0 7px;color:${BLUE};font-family:'Courier New',Courier,monospace;font-size:10px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase">${escapeHtml(label)}</div>
      <div style="color:${TEXT};font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:700;line-height:1.35">${escapeHtml(value)}</div>
      ${copy ? `<div style="margin-top:7px;color:${MUTED};font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.55">${escapeHtml(copy)}</div>` : ''}
    </td></tr>
  </table>`;
}

export function emailSteps(items = []) {
  const rows = items.map((item, index) => `<tr>
    <td valign="top" style="width:34px;padding:0 10px 14px 0">
      <div style="width:28px;height:28px;border:1px solid ${BLUE};color:${BLUE};font-family:'Courier New',Courier,monospace;font-size:12px;font-weight:700;line-height:28px;text-align:center">0${index + 1}</div>
    </td>
    <td valign="top" style="padding:3px 0 14px;color:${MUTED};font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55">${escapeHtml(item)}</td>
  </tr>`).join('');
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:20px 0">${rows}</table>`;
}

export function brandEmail({
  siteUrl,
  preheader,
  eyebrow,
  heading,
  lead,
  content = '',
  action,
  actionLabel,
  secondaryAction,
  secondaryActionLabel,
  footer,
  internal = false,
  wide = false
}) {
  const safeSite = String(siteUrl || 'https://joseph.clonecentre.ai').replace(/\/$/, '');
  const logoUrl = `${safeSite}/assets/clonecentre_logo.png`;
  const memberUrl = `${safeSite}/member`;
  const libraryUrl = `${safeSite}/library`;
  const maxWidth = wide ? 700 : 640;
  const footerCopy = footer || (internal
    ? 'Private operational email. The master record remains securely stored in Railway.'
    : 'You are receiving this because you requested something from Clone Centre. Reply to this email if you need a human.');
  const actions = action && actionLabel
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:26px"><tr><td>${emailButton(action, actionLabel)}${secondaryAction && secondaryActionLabel ? emailButton(secondaryAction, secondaryActionLabel, { secondary: true }) : ''}</td></tr></table>`
    : '';

  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>${escapeHtml(heading)}</title>
  <style>
    body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}table,td{mso-table-lspace:0pt;mso-table-rspace:0pt}img{-ms-interpolation-mode:bicubic;border:0;display:block;height:auto;line-height:100%;outline:none;text-decoration:none}table{border-collapse:collapse!important}body{height:100%!important;margin:0!important;padding:0!important;width:100%!important}
    @media only screen and (max-width:620px){.email-shell{width:100%!important}.email-pad{padding-left:22px!important;padding-right:22px!important}.brand-name{font-size:20px!important}.hero-heading{font-size:31px!important;line-height:1.03!important}.detail-label{width:100px!important}.footer-link{display:block!important;margin:0 0 10px!important}}
  </style>
</head>
<body style="margin:0!important;padding:0!important;background:${INK};color:${TEXT}">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(preheader || lead || heading)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${INK}" style="background:${INK}">
    <tr><td align="center" style="padding:22px 10px 40px">
      <table class="email-shell" role="presentation" width="${maxWidth}" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:${maxWidth}px;border:1px solid ${BORDER};background:#04080c">
        <tr><td height="4" bgcolor="${BLUE}" style="height:4px;background:${BLUE};font-size:0;line-height:0">&nbsp;</td></tr>
        <tr><td class="email-pad" style="padding:24px 34px;border-bottom:1px solid ${BORDER}">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            <tr>
              <td width="68" valign="middle"><a href="${safeUrl(safeSite)}"><img src="${safeUrl(logoUrl)}" width="56" height="56" alt="Clone Centre" style="width:56px;height:56px;border:1px solid ${BORDER}"></a></td>
              <td valign="middle">
                <div class="brand-name" style="color:#f4f8fb;font-family:'Courier New',Courier,monospace;font-size:23px;font-weight:700;letter-spacing:-1px">Clone<span style="color:${BLUE}">Centre</span></div>
                <div style="margin-top:4px;color:#6f879a;font-family:'Courier New',Courier,monospace;font-size:9px;letter-spacing:2px;text-transform:uppercase">AI MADE USEFUL</div>
              </td>
              <td align="right" valign="middle" style="color:${BLUE};font-family:'Courier New',Courier,monospace;font-size:10px;letter-spacing:1.4px">ONLINE&nbsp;&nbsp;●</td>
            </tr>
          </table>
        </td></tr>
        <tr><td class="email-pad" style="padding:38px 34px 12px;background-color:#04080c;background-image:linear-gradient(rgba(46,155,255,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(46,155,255,.035) 1px,transparent 1px);background-size:20px 20px">
          <div style="margin:0 0 15px;color:${BLUE};font-family:'Courier New',Courier,monospace;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase">// ${escapeHtml(eyebrow)}</div>
          <h1 class="hero-heading" style="margin:0 0 17px;color:#ffffff;font-family:Arial Black,Arial,Helvetica,sans-serif;font-size:39px;line-height:1.04;letter-spacing:-1.3px">${escapeHtml(heading)}</h1>
          ${lead ? `<p style="margin:0;color:#b2c0cd;font-family:Arial,Helvetica,sans-serif;font-size:17px;line-height:1.65">${escapeHtml(lead)}</p>` : ''}
        </td></tr>
        <tr><td class="email-pad" style="padding:20px 34px 34px">
          ${content}
          ${actions}
          ${internal ? '' : `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:30px;border-top:1px solid ${BORDER}"><tr><td style="padding-top:22px"><div style="color:#e7f1f9;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700">Joseph Conlan</div><div style="margin-top:4px;color:#7f91a1;font-family:'Courier New',Courier,monospace;font-size:10px;letter-spacing:1.2px">FOUNDER // CLONE CENTRE</div></td></tr></table>`}
        </td></tr>
        <tr><td class="email-pad" style="padding:22px 34px;border-top:1px solid ${BORDER};background:#020507">
          <p style="margin:0 0 14px;color:#71818f;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6">${escapeHtml(footerCopy)}</p>
          <p style="margin:0;color:#6f879a;font-family:'Courier New',Courier,monospace;font-size:10px;line-height:1.8;letter-spacing:.5px">
            <a class="footer-link" href="${safeUrl(safeSite)}" style="color:${BLUE};text-decoration:none">WEBSITE</a>&nbsp;&nbsp; // &nbsp;&nbsp;
            <a class="footer-link" href="${safeUrl(memberUrl)}" style="color:${BLUE};text-decoration:none">MEMBER CENTRE</a>&nbsp;&nbsp; // &nbsp;&nbsp;
            <a class="footer-link" href="${safeUrl(libraryUrl)}" style="color:${BLUE};text-decoration:none">LIBRARY</a>
          </p>
          <p style="margin:15px 0 0;color:#4f606e;font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.6">Clone Centre · Practical AI for people and businesses · United Kingdom</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function plainTextFromHtml(html = '') {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<div style="display:none[\s\S]*?<\/div>/i, '')
    .replace(/<(br|\/p|\/div|\/tr|\/h[1-6]|\/li)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#847;|&zwnj;/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function completeEmailMessage(message) {
  if (!message?.html || message.text) return message;
  return { ...message, text: plainTextFromHtml(message.html) };
}
