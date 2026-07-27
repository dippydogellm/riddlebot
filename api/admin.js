/**
 * Password-protected admin panel: lets the bot owner set the sellable
 * ad-footer link (text + URL) shown at the bottom of bot messages.
 *
 * Settings are stored in Vercel Edge Config, not the bot's SQLite file —
 * Edge Config is the one thing this project and the webhook function
 * reliably share, since Vercel doesn't guarantee shared local disk between
 * separate function invocations.
 *
 * Auth: a signed, expiring cookie (HMAC-SHA256 over an expiry timestamp)
 * checked against ADMIN_USER / ADMIN_PASS / ADMIN_SESSION_SECRET env vars.
 * No plaintext credentials in source — everything comes from env vars set
 * in the Vercel dashboard.
 */

import crypto from 'node:crypto';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function sign(expiry) {
  const secret = process.env.ADMIN_SESSION_SECRET;
  const mac = crypto.createHmac('sha256', secret).update(String(expiry)).digest('hex');
  return `${expiry}.${mac}`;
}

function verify(token) {
  if (!token) return false;
  const [expiry, mac] = token.split('.');
  if (!expiry || !mac) return false;
  if (Date.now() > Number(expiry)) return false;
  const expected = sign(expiry).split('.')[1];
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

async function readSettings() {
  const id = process.env.EDGE_CONFIG_ID;
  const token = process.env.EDGE_CONFIG_READ_TOKEN;
  const res = await fetch(`https://edge-config.vercel.com/${id}/items?token=${token}`);
  return res.ok ? res.json() : {};
}

async function writeSettings(items) {
  const id = process.env.EDGE_CONFIG_ID;
  const apiToken = process.env.VERCEL_API_TOKEN;
  const res = await fetch(`https://api.vercel.com/v1/edge-config/${id}/items`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({
      items: Object.entries(items).map(([key, value]) => ({ operation: 'upsert', key, value })),
    }),
  });
  if (!res.ok) throw new Error(`Edge Config write failed: ${res.status} ${await res.text()}`);
}

const escHtml = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

function page({ error, saved, adText, adUrl }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Riddle Bot Admin</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font-family:system-ui,sans-serif;background:#0A0A0A;color:#F4F0E6;max-width:480px;margin:40px auto;padding:0 16px}
  h1{font-size:1.2rem}
  input{width:100%;box-sizing:border-box;padding:10px;margin:6px 0 16px;border-radius:6px;border:1px solid #444;background:#151515;color:#F4F0E6}
  button{padding:10px 18px;border-radius:6px;border:none;background:#F4F0E6;color:#0A0A0A;font-weight:600;cursor:pointer}
  .msg{padding:8px 12px;border-radius:6px;margin-bottom:16px}
  .err{background:#3a1414;color:#ffb4b4}
  .ok{background:#123a1c;color:#b4ffc6}
  label{font-size:.85rem;opacity:.8}
</style></head><body>
<h1>Riddle Bot — Ad Slot</h1>
${error ? `<div class="msg err">${escHtml(error)}</div>` : ''}
${saved ? `<div class="msg ok">Saved. Live within ~30s.</div>` : ''}
<form method="POST">
  <label>Ad text</label>
  <input name="ad_text" value="${escHtml(adText)}" maxlength="80" placeholder="e.g. Sponsored: TokenX — 0% fees this week">
  <label>Ad URL</label>
  <input name="ad_url" value="${escHtml(adUrl)}" maxlength="300" placeholder="https://...">
  <button type="submit">Save</button>
</form>
<p><a href="/api/admin/logout" style="color:#888">Log out</a></p>
</body></html>`;
}

function loginPage(error) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Riddle Bot Admin — Login</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font-family:system-ui,sans-serif;background:#0A0A0A;color:#F4F0E6;max-width:360px;margin:80px auto;padding:0 16px}
  input{width:100%;box-sizing:border-box;padding:10px;margin:6px 0 16px;border-radius:6px;border:1px solid #444;background:#151515;color:#F4F0E6}
  button{padding:10px 18px;border-radius:6px;border:none;background:#F4F0E6;color:#0A0A0A;font-weight:600;cursor:pointer}
  .err{background:#3a1414;color:#ffb4b4;padding:8px 12px;border-radius:6px;margin-bottom:16px}
</style></head><body>
<h1>Riddle Bot Admin</h1>
${error ? `<div class="err">${escHtml(error)}</div>` : ''}
<form method="POST" action="/api/admin/login">
  <input name="user" placeholder="Username" autocomplete="username">
  <input name="pass" type="password" placeholder="Password" autocomplete="current-password">
  <button type="submit">Log in</button>
</form>
</body></html>`;
}

function setCookie(res, value, maxAgeSec) {
  res.setHeader('Set-Cookie', `admin_session=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`);
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('content-type', 'text/html; charset=utf-8');

  if (url.pathname.endsWith('/logout')) {
    setCookie(res, '', 0);
    res.writeHead(302, { Location: '/api/admin' });
    return res.end();
  }

  if (url.pathname.endsWith('/login') && req.method === 'POST') {
    const { user, pass } = req.body || {};
    if (user === process.env.ADMIN_USER && pass === process.env.ADMIN_PASS) {
      const expiry = Date.now() + SESSION_TTL_MS;
      setCookie(res, sign(expiry), SESSION_TTL_MS / 1000);
      res.writeHead(302, { Location: '/api/admin' });
      return res.end();
    }
    return res.status(401).send(loginPage('Wrong username or password.'));
  }

  const cookies = parseCookies(req.headers.cookie || '');
  if (!verify(cookies.admin_session)) {
    return res.status(200).send(loginPage());
  }

  if (req.method === 'POST') {
    try {
      const { ad_text = '', ad_url = '' } = req.body || {};
      await writeSettings({ ad_text: ad_text.trim(), ad_url: ad_url.trim() });
      const s = await readSettings();
      return res.status(200).send(page({ saved: true, adText: s.ad_text || '', adUrl: s.ad_url || '' }));
    } catch (e) {
      return res.status(500).send(page({ error: e.message, adText: '', adUrl: '' }));
    }
  }

  const s = await readSettings();
  return res.status(200).send(page({ adText: s.ad_text || '', adUrl: s.ad_url || '' }));
}
