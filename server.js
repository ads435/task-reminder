// Task & Certificate Renewal Tracker — server with email reminders
require('fs').existsSync('.env') && loadEnv('.env');
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const crypto = require('crypto');
const express = require('express');
const nodemailer = require('nodemailer');

function loadEnv(file) {
  for (const line of require('fs').readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.json');
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// ---------- storage ----------
const defaults = () => ({
  tasks: [], certs: [], sent: {}, notifications: [],
  settings: { recipients: [], certDays: [90, 60, 30, 14, 7, 3, 1], taskDays: [1, 0], sendHour: 9 },
});
let db = defaults();
// Storage: Vercel Blob (private) when BLOB_READ_WRITE_TOKEN is set, otherwise a local JSON file.
const useBlob = !!process.env.BLOB_READ_WRITE_TOKEN;
const blob = useBlob ? require('@vercel/blob') : null;
async function loadDb() {
  if (useBlob) {
    const r = await blob.get('data.json', { access: 'private', useCache: false });
    db = r && r.stream ? { ...defaults(), ...JSON.parse(await new Response(r.stream).text()) } : defaults();
  } else if (fs.existsSync(DB_FILE)) {
    try { db = { ...defaults(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch (e) { console.error('Bad db file', e); }
  }
}
async function save() {
  if (useBlob) {
    await blob.put('data.json', JSON.stringify(db), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
  } else { fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db, null, 2)); fs.renameSync(DB_FILE + '.tmp', DB_FILE); }
}
const id = () => crypto.randomBytes(6).toString('hex');

// ---------- email ----------
const smtpConfigured = !!process.env.SMTP_HOST;
const transport = smtpConfigured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: +(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    })
  : nodemailer.createTransport({ jsonTransport: true }); // dry-run: nothing leaves the machine
const FROM = process.env.MAIL_FROM || process.env.SMTP_USER || 'reminders@localhost';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function sendMail(to, subject, html, text) {
  const info = await transport.sendMail({ from: FROM, to: to.join(', '), subject, html, text });
  const entry = {
    id: id(), at: new Date().toISOString(), to, subject,
    status: smtpConfigured ? 'sent' : 'dry-run (SMTP not configured)',
  };
  db.notifications.unshift(entry);
  db.notifications = db.notifications.slice(0, 200);
  await save();
  if (!smtpConfigured) console.log('[dry-run email]', subject, '->', to.join(', '));
  return { info, entry };
}

// ---------- dates ----------
const TZ = process.env.APP_TZ || process.env.TZ || 'UTC';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD in APP_TZ
const hourNow = () => +new Date().toLocaleString('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false });
const daysUntil = d => Math.round((Date.parse(d + 'T00:00:00Z') - Date.parse(today() + 'T00:00:00Z')) / 864e5);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(Date.parse(s));

// ---------- reminder engine ----------
// Fires once per threshold (e.g. 30 days left), then daily once expired/overdue.
function due(item, kind, thresholds, dateField) {
  const d = daysUntil(item[dateField]);
  const stamp = item[dateField];
  const keyBase = `${kind}:${item.id}:${stamp}`;
  if (d < 0) {
    const key = `${keyBase}:late:${today()}`;
    return db.sent[key] ? null : { d, keys: [key], level: 'overdue' };
  }
  const hit = thresholds.filter(t => d <= t).sort((a, b) => a - b);
  if (!hit.length) return null;
  const key = `${keyBase}:${hit[0]}`;
  if (db.sent[key]) return null;
  return { d, keys: hit.map(t => `${keyBase}:${t}`), level: d <= 7 ? 'urgent' : 'upcoming' };
}

function collectReminders() {
  const s = db.settings, out = [];
  for (const c of db.certs) {
    const r = due(c, 'cert', s.certDays, 'expiry');
    if (r) out.push({ kind: 'cert', item: c, ...r });
  }
  for (const t of db.tasks) {
    if (t.status === 'done' || !t.due) continue;
    const r = due(t, 'task', s.taskDays, 'due');
    if (r) out.push({ kind: 'task', item: t, ...r });
  }
  return out;
}

const phrase = (d, noun) => d < 0 ? `${noun} ${-d} day${d === -1 ? '' : 's'} ago` : d === 0 ? `${noun} TODAY` : `${noun} in ${d} day${d === 1 ? '' : 's'}`;

function buildEmail(reminders) {
  const certs = reminders.filter(r => r.kind === 'cert').sort((a, b) => a.d - b.d);
  const tasks = reminders.filter(r => r.kind === 'task').sort((a, b) => a.d - b.d);
  const color = r => (r.d < 0 ? '#c0392b' : r.d <= 7 ? '#d9822b' : '#2d7d5a');
  const row = (r, label, sub) =>
    `<tr><td style="padding:10px 12px;border-bottom:1px solid #eee"><b>${esc(label)}</b><br><span style="color:#777;font-size:12px">${esc(sub)}</span></td>` +
    `<td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;color:${color(r)};font-weight:600">${esc(phrase(r.d, r.kind === 'cert' ? (r.d < 0 ? 'expired' : 'expires') : (r.d < 0 ? 'due' : 'due')))}</td></tr>`;
  let html = `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:620px;margin:auto;color:#222">`;
  let text = '';
  if (certs.length) {
    html += `<h2 style="margin:20px 0 6px">Certificates needing renewal</h2><table style="width:100%;border-collapse:collapse">` +
      certs.map(r => row(r, r.item.name, `${r.item.domain || ''} · ${r.item.expiry}${r.item.issuer ? ' · ' + r.item.issuer : ''}`)).join('') + '</table>';
    text += 'CERTIFICATES\n' + certs.map(r => `- ${r.item.name} (${r.item.domain || '-'}) — ${phrase(r.d, r.d < 0 ? 'expired' : 'expires')} [${r.item.expiry}]`).join('\n') + '\n\n';
  }
  if (tasks.length) {
    html += `<h2 style="margin:20px 0 6px">Tasks due</h2><table style="width:100%;border-collapse:collapse">` +
      tasks.map(r => row(r, r.item.title, `${r.item.priority || 'medium'} priority · ${r.item.due}`)).join('') + '</table>';
    text += 'TASKS\n' + tasks.map(r => `- ${r.item.title} — ${phrase(r.d, 'due')} [${r.item.due}]`).join('\n') + '\n\n';
  }
  html += `<p style="margin-top:24px"><a href="${esc(APP_URL)}" style="background:#1f6feb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Open tracker</a></p></div>`;
  text += APP_URL;
  const worst = Math.min(...reminders.map(r => r.d));
  const subject = `${worst < 0 ? '🔴 OVERDUE' : worst <= 7 ? '🟠 Action needed' : '🔔 Reminder'}: ${certs.length} certificate${certs.length === 1 ? '' : 's'}, ${tasks.length} task${tasks.length === 1 ? '' : 's'}`;
  return { subject, html, text };
}

function recipientsFor(reminders) {
  const set = new Set(db.settings.recipients);
  for (const r of reminders) if (r.item.ownerEmail) set.add(r.item.ownerEmail);
  return [...set];
}

let running = false;
async function runCheck({ force = false } = {}) {
  if (running) return { sent: 0, note: 'already running' };
  running = true;
  try {
    if (!force && hourNow() < db.settings.sendHour) return { sent: 0, note: 'before send hour' };
    const reminders = collectReminders();
    if (!reminders.length) return { sent: 0, note: 'nothing due' };
    // one digest per recipient set: global recipients get everything, owners get their own items
    const globals = db.settings.recipients;
    const groups = new Map();
    for (const r of reminders) {
      const to = [...new Set([...globals, ...(r.item.ownerEmail ? [r.item.ownerEmail] : [])])];
      if (!to.length) continue;
      const k = to.sort().join(',');
      (groups.get(k) || groups.set(k, { to, items: [] }).get(k)).items.push(r);
    }
    let sent = 0;
    for (const g of groups.values()) {
      const { subject, html, text } = buildEmail(g.items);
      try {
        await sendMail(g.to, subject, html, text);
        g.items.forEach(r => r.keys.forEach(k => (db.sent[k] = new Date().toISOString())));
        sent += g.items.length;
      } catch (e) {
        console.error('Email failed:', e.message);
        db.notifications.unshift({ id: id(), at: new Date().toISOString(), to: g.to, subject, status: 'FAILED: ' + e.message });
      }
    }
    await save();
    const skipped = reminders.length - sent;
    return { sent, note: skipped ? `${skipped} reminder(s) had no recipient or failed — add a recipient in Settings` : 'ok' };
  } finally { running = false; }
}

// ---------- API ----------
const app = express();
app.use(express.json());

app.get('/api/cron', async (req, res) => {
  const sec = process.env.CRON_SECRET;
  if (!sec || req.headers.authorization !== 'Bearer ' + sec) return res.status(401).json({ error: 'unauthorized' });
  await loadDb();
  res.json(await runCheck({ force: true }));
});

if (process.env.APP_PASSWORD) {
  app.use((req, res, next) => {
    const [, b64] = (req.headers.authorization || '').split(' ');
    const [, pass] = Buffer.from(b64 || '', 'base64').toString().split(/:(.*)/s);
    const ok = pass && pass.length === process.env.APP_PASSWORD.length &&
      crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(process.env.APP_PASSWORD));
    if (ok) return next();
    res.set('WWW-Authenticate', 'Basic realm="Renewal Tracker"').status(401).send('Login required');
  });
}
app.use(express.static(path.join(__dirname, 'ui')));
app.use('/api', async (req, res, next) => { try { if (useBlob) await loadDb(); next(); } catch (e) { next(e); } });

const email = s => !s || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

app.get('/api/state', async (req, res) => res.json({ ...db, sent: undefined, smtpConfigured, today: today() }));

app.post('/api/tasks', async (req, res) => {
  const { title, description = '', due = '', priority = 'medium', ownerEmail = '' } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });
  if (due && !isDate(due)) return res.status(400).json({ error: 'Invalid due date' });
  if (!email(ownerEmail)) return res.status(400).json({ error: 'Invalid email' });
  const t = { id: id(), title: title.trim(), description, due, priority, ownerEmail, status: 'open', created: new Date().toISOString() };
  db.tasks.push(t); await save(); res.json(t);
});
app.put('/api/tasks/:id', async (req, res) => {
  const t = db.tasks.find(x => x.id === req.params.id);
  if (!t) return res.sendStatus(404);
  const b = req.body;
  if (b.due && !isDate(b.due)) return res.status(400).json({ error: 'Invalid due date' });
  if (!email(b.ownerEmail)) return res.status(400).json({ error: 'Invalid email' });
  for (const k of ['title', 'description', 'due', 'priority', 'ownerEmail', 'status']) if (k in b) t[k] = b[k];
  await save(); res.json(t);
});
app.delete('/api/tasks/:id', async (req, res) => { db.tasks = db.tasks.filter(x => x.id !== req.params.id); await save(); res.json({ ok: true }); });

app.post('/api/certs', async (req, res) => {
  const { name, domain = '', issuer = '', expiry, ownerEmail = '', notes = '' } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!isDate(expiry)) return res.status(400).json({ error: 'Valid expiry date required' });
  if (!email(ownerEmail)) return res.status(400).json({ error: 'Invalid email' });
  const c = { id: id(), name: name.trim(), domain, issuer, expiry, ownerEmail, notes, history: [], created: new Date().toISOString() };
  db.certs.push(c); await save(); res.json(c);
});
app.put('/api/certs/:id', async (req, res) => {
  const c = db.certs.find(x => x.id === req.params.id);
  if (!c) return res.sendStatus(404);
  const b = req.body;
  if ('expiry' in b && !isDate(b.expiry)) return res.status(400).json({ error: 'Invalid expiry' });
  if (!email(b.ownerEmail)) return res.status(400).json({ error: 'Invalid email' });
  for (const k of ['name', 'domain', 'issuer', 'expiry', 'ownerEmail', 'notes']) if (k in b) c[k] = b[k];
  await save(); res.json(c);
});
app.post('/api/certs/:id/renew', async (req, res) => {
  const c = db.certs.find(x => x.id === req.params.id);
  if (!c) return res.sendStatus(404);
  if (!isDate(req.body.expiry)) return res.status(400).json({ error: 'Valid new expiry required' });
  c.history.push({ renewedOn: today(), previousExpiry: c.expiry });
  c.expiry = req.body.expiry; // new expiry date => new reminder keys, cycle restarts
  await save(); res.json(c);
});
app.delete('/api/certs/:id', async (req, res) => { db.certs = db.certs.filter(x => x.id !== req.params.id); await save(); res.json({ ok: true }); });

// Read the live expiry date of a public TLS endpoint
app.get('/api/certs/lookup', async (req, res) => {
  const host = String(req.query.host || '').replace(/^https?:\/\//, '').split('/')[0];
  const [h, p] = host.split(':');
  if (!/^[a-z0-9.-]+$/i.test(h || '')) return res.status(400).json({ error: 'Invalid host' });
  const sock = tls.connect({ host: h, port: +p || 443, servername: h, timeout: 8000, rejectUnauthorized: false }, () => {
    const c = sock.getPeerCertificate();
    sock.end();
    if (!c?.valid_to) return res.status(502).json({ error: 'No certificate returned' });
    res.json({ expiry: new Date(c.valid_to).toISOString().slice(0, 10), issuer: c.issuer?.O || c.issuer?.CN || '', subject: c.subject?.CN || h });
  });
  sock.on('error', e => res.headersSent || res.status(502).json({ error: e.message }));
  sock.on('timeout', () => { sock.destroy(); res.headersSent || res.status(504).json({ error: 'Timed out' }); });
});

app.put('/api/settings', async (req, res) => {
  const { recipients, certDays, taskDays, sendHour } = req.body;
  const nums = a => Array.isArray(a) && a.every(n => Number.isInteger(n) && n >= 0 && n <= 730);
  if (recipients && !(Array.isArray(recipients) && recipients.every(e => email(e) && e))) return res.status(400).json({ error: 'Invalid recipient email' });
  if (certDays && !nums(certDays)) return res.status(400).json({ error: 'Invalid certificate days' });
  if (taskDays && !nums(taskDays)) return res.status(400).json({ error: 'Invalid task days' });
  if (sendHour !== undefined && !(Number.isInteger(sendHour) && sendHour >= 0 && sendHour <= 23)) return res.status(400).json({ error: 'Invalid hour' });
  Object.assign(db.settings, Object.fromEntries(Object.entries({ recipients, certDays, taskDays, sendHour }).filter(([, v]) => v !== undefined)));
  db.settings.certDays.sort((a, b) => b - a); db.settings.taskDays.sort((a, b) => b - a);
  await save(); res.json(db.settings);
});

app.post('/api/test-email', async (req, res) => {
  const to = db.settings.recipients;
  if (!to.length) return res.status(400).json({ error: 'Add at least one recipient first' });
  try {
    const { entry } = await sendMail(to, '✅ Test email from Renewal Tracker', '<p>Email reminders are working.</p>', 'Email reminders are working.');
    res.json(entry);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/run-check', async (req, res) => res.json(await runCheck({ force: true })));
app.delete('/api/notifications', async (req, res) => { db.notifications = []; await save(); res.json({ ok: true }); });

// ---------- scheduler ----------
module.exports = app;
if (require.main === module) loadDb().then(() => {
setInterval(() => runCheck().catch(console.error), 15 * 60 * 1000);
setTimeout(() => runCheck().catch(console.error), 5000);
app.listen(PORT, () => {
  console.log(`Renewal Tracker running at ${APP_URL}`);
  console.log(smtpConfigured ? `Email via ${process.env.SMTP_HOST}` : 'SMTP not configured — emails are DRY-RUN (set SMTP_HOST in .env)');
});
});
