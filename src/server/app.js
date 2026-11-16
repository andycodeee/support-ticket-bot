import express from 'express';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { db } from '../db.js';
import { log } from '../logger.js';

export const CATEGORIES = ['Report', 'FailedPurcahse', 'Bug', 'Other'];

const LEASE_MS = 60_000;
const DUPLICATE_WINDOW_MS = 30_000;
const MAX_MINUTES = 1_000_000_000;
const MAX_RESPONSE_LENGTH = 1000;
const MAX_EXPLANATION_LENGTH = 1000;
const ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const logoPath = fileURLToPath(new URL('../../logo.png', import.meta.url));

const isPositiveInt = (v) => Number.isSafeInteger(v) && v > 0;
const toUserId = (v) => {
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return v;
};
const bad = (res, message) => res.status(400).json({ error: 'invalid_request', message });

function secretMatches(provided) {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(config.apiSecret, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireSecret(req, res, next) {
  if (!secretMatches(req.get('X-API-Secret'))) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

function safeStringMatches(provided, expected) {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireQueueAuth(req, res, next) {
  if (!config.queuePassword) return res.status(404).send('Not found');

  const credentials = /^Basic\s+(.+)$/i.exec(req.get('Authorization') ?? '');
  let username = '';
  let password = '';
  if (credentials) {
    try {
      const decoded = Buffer.from(credentials[1], 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator >= 0) {
        username = decoded.slice(0, separator);
        password = decoded.slice(separator + 1);
      }
    } catch {
      // Invalid credentials fall through to the authentication challenge.
    }
  }

  if (safeStringMatches(username, 'queue') && safeStringMatches(password, config.queuePassword)) {
    return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Support response queue", charset="UTF-8"');
  return res.status(401).send('Authentication required');
}

const listResponseQueue = db.prepare(`
  SELECT r.id, r.ticket_id, r.user_id, t.username, r.response, r.minutes, r.created_at, r.acked_at
  FROM responses r
  JOIN tickets t ON t.id = r.ticket_id
  ORDER BY CASE WHEN r.acked_at IS NULL THEN 0 ELSE 1 END, r.created_at DESC
  LIMIT 200
`);
const responseQueueCounts = db.prepare(`
  SELECT COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN acked_at IS NULL THEN 1 ELSE 0 END), 0) AS pending
  FROM responses
`);

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[char]));

function renderQueuePage(rows, counts) {
  const items = rows.map((row) => {
    const acknowledged = row.acked_at !== null;
    const status = acknowledged
      ? `Acknowledged<small>${escapeHtml(new Date(row.acked_at).toISOString().replace('T', ' ').slice(0, 19))} UTC</small>`
      : 'Waiting';
    return `<tr>
      <td><strong>#${escapeHtml(row.ticket_id)}</strong><small>${escapeHtml(row.username)} · ${escapeHtml(row.user_id)}</small></td>
      <td class="response">${escapeHtml(row.response)}</td>
      <td>${escapeHtml(row.minutes)}</td>
      <td><small>${escapeHtml(new Date(row.created_at).toISOString().replace('T', ' ').slice(0, 19))} UTC</small></td>
      <td class="status">${status}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>Response Queue</title>
<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 30px 20px;
  background: #fff;
  color: #111;
  font-family: Arial, sans-serif;
  font-size: 14px;
}

main {
  width: 100%;
  max-width: 900px;
  margin: auto;
}

header {
  text-align: center;
  margin-bottom: 40px;
}

.logo {
  width: 48px;
  height: 48px;
  object-fit: contain;
  display: block;
  margin: 0 auto 16px;
}

h1 {
  font-size: 24px;
  font-weight: 500;
  margin: 0;
}

.stats {
  display: flex;
  justify-content: center;
  gap: 60px;
  margin-bottom: 40px;
  text-align: center;
}

.stat-label {
  color: #777;
  font-size: 12px;
  margin-bottom: 5px;
}

.stat-value {
  font-size: 24px;
  font-weight: 500;
}

.table-wrap {
  overflow-x: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
  min-width: 700px;
}

th {
  font-size: 11px;
  font-weight: 500;
  color: #777;
  text-transform: uppercase;
  padding: 12px;
  border-bottom: 1px solid #ddd;
}

td {
  padding: 14px 12px;
  border-bottom: 1px solid #eee;
  vertical-align: top;
}

td small {
  display: block;
  color: #888;
  margin-top: 4px;
}

.response {
  max-width: 400px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.status {
  font-size: 12px;
}

.empty {
  text-align: center;
  color: #888;
  padding: 40px 10px;
}

@media(max-width:600px) {
  body {
    padding: 20px 15px;
  }

  .stats {
    gap: 25px;
  }
}
</style>
</head>

<body>
<main>

<header>
  <img
    src="/logo.png"
    alt="Logo"
    class="logo"
  >
  <h1>Response Queue</h1>
</header>

<section class="stats">
  <div>
    <div class="stat-label">All responses</div>
    <div class="stat-value">${escapeHtml(counts.total)}</div>
  </div>

  <div>
    <div class="stat-label">Waiting</div>
    <div class="stat-value">${escapeHtml(counts.pending)}</div>
  </div>

  <div>
    <div class="stat-label">Acknowledged</div>
    <div class="stat-value">${escapeHtml(counts.total - counts.pending)}</div>
  </div>
</section>

<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>Ticket / Player</th>
        <th>Response</th>
        <th>Minutes</th>
        <th>Sent</th>
        <th>Status</th>
      </tr>
    </thead>

    <tbody>
      ${items || '<tr><td class="empty" colspan="5">No responses yet.</td></tr>'}
    </tbody>
  </table>
</div>

</main>
</body>
</html>`;
}

const findByRequestId = db.prepare('SELECT id, status FROM tickets WHERE request_id = ?');
const findRecentDuplicate = db.prepare(
  'SELECT id, status FROM tickets WHERE user_id = ? AND category = ? AND explanation = ? AND created_at >= ? ORDER BY id DESC LIMIT 1',
);
const insertTicket = db.prepare(
  "INSERT INTO tickets (request_id, user_id, username, category, explanation, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
);
const listTickets = db.prepare(`
  SELECT t.id, t.user_id, t.username, t.category, t.explanation, t.status, t.created_at,
         r.response, r.minutes, r.responder_id, r.created_at AS responded_at
  FROM tickets t
  LEFT JOIN responses r ON r.ticket_id = t.id
  WHERE t.id > ?
  ORDER BY t.id ASC
  LIMIT ?
`);
const pendingForDelivery = db.prepare(
  'SELECT id, user_id, response, minutes FROM responses WHERE acked_at IS NULL AND leased_until <= ? ORDER BY created_at ASC LIMIT 50',
);
const leaseResponse = db.prepare('UPDATE responses SET leased_until = ? WHERE id = ?');
const leaseBatch = db.transaction((rows, until) => {
  for (const r of rows) leaseResponse.run(until, r.id);
});
const getResponse = db.prepare('SELECT id, acked_at FROM responses WHERE id = ?');
const markAcked = db.prepare('UPDATE responses SET acked_at = ?, leased_until = 0 WHERE id = ? AND acked_at IS NULL');
const getTicket = db.prepare('SELECT id, user_id FROM tickets WHERE id = ?');
const getResponseById = db.prepare('SELECT id, ticket_id FROM responses WHERE id = ?');
const getResponseForTicket = db.prepare('SELECT id FROM responses WHERE ticket_id = ?');
const insertResponse = db.prepare(
  'INSERT INTO responses (id, ticket_id, user_id, response, minutes, responder_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
);
const markAnswered = db.prepare("UPDATE tickets SET status = 'answered' WHERE id = ?");
const saveResponse = db.transaction((row) => {
  insertResponse.run(row.id, row.ticketId, row.userId, row.response, row.minutes, row.responderId, row.createdAt);
  markAnswered.run(row.ticketId);
});

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '32kb', type: () => true }));

  app.get('/health', (_req, res) => res.json({ ok: true, build: 'string-userid-v2' }));

  app.get('/logo.png', (_req, res) => res.sendFile(logoPath));

  app.get('/queue', requireQueueAuth, (_req, res) => {
    const rows = listResponseQueue.all();
    const counts = responseQueueCounts.get();
    res.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.type('html').send(renderQueuePage(rows, counts));
  });

  app.use('/support', requireSecret);

  app.post('/support', (req, res) => {
    const body = req.body ?? {};
    const userId = toUserId(body.userId);
    const { username, category, explanation, requestId } = body;

    if (!isPositiveInt(userId)) {
      log.warn(`Rejected ticket: userId type=${typeof body.userId} value=${JSON.stringify(body.userId)}`);
      return bad(res, 'userId must be a positive integer');
    }
    if (typeof username !== 'string' || !username.trim() || username.trim().length > 64) {
      return bad(res, 'username must be 1-64 characters');
    }
    if (!CATEGORIES.includes(category)) {
      return bad(res, `category must be one of: ${CATEGORIES.join(', ')}`);
    }
    if (typeof explanation !== 'string' || !explanation.trim() || explanation.trim().length > MAX_EXPLANATION_LENGTH) {
      return bad(res, `explanation must be 1-${MAX_EXPLANATION_LENGTH} characters`);
    }
    if (requestId !== undefined && requestId !== null && (typeof requestId !== 'string' || requestId.length > 128)) {
      return bad(res, 'requestId must be a string up to 128 characters');
    }

    const cleanName = username.trim();
    const cleanText = explanation.trim();
    const now = Date.now();

    if (requestId) {
      const existing = findByRequestId.get(requestId);
      if (existing) return res.json({ id: existing.id, status: existing.status, duplicate: true });
    }
    const recent = findRecentDuplicate.get(userId, category, cleanText, now - DUPLICATE_WINDOW_MS);
    if (recent) return res.json({ id: recent.id, status: recent.status, duplicate: true });

    const info = insertTicket.run(requestId || null, userId, cleanName, category, cleanText, now);
    const id = Number(info.lastInsertRowid);
    log.info(`Ticket #${id} created (category=${category})`);
    res.status(201).json({ id, status: 'pending' });
  });

  app.get('/support/tickets', (req, res) => {
    const afterId = Number(req.query.afterId ?? 0);
    const limit = Number(req.query.limit ?? 50);
    if (!Number.isSafeInteger(afterId) || afterId < 0) return bad(res, 'afterId must be a non-negative integer');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) return bad(res, 'limit must be 1-200');

    const rows = listTickets.all(afterId, limit);
    res.json({
      tickets: rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        username: r.username,
        category: r.category,
        explanation: r.explanation,
        status: r.status,
        createdAt: r.created_at,
        response: r.response ?? null,
        minutes: r.minutes ?? null,
        responderId: r.responder_id ?? null,
        respondedAt: r.responded_at ?? null,
      })),
    });
  });

  app.get('/support/responses', (_req, res) => {
    const now = Date.now();
    const rows = pendingForDelivery.all(now);
    leaseBatch(rows, now + LEASE_MS);
    res.json({
      responses: rows.map((r) => ({ id: r.id, userId: r.user_id, response: r.response, minutes: r.minutes })),
    });
  });

  app.post('/support/responses/ack', (req, res) => {
    const id = req.body?.id;
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) return bad(res, 'id is required');
    const row = getResponse.get(id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    const info = markAcked.run(Date.now(), id);
    res.json({ ok: true, alreadyAcked: info.changes === 0 });
  });

  app.post('/support/responses', (req, res) => {
    const body = req.body ?? {};
    const { id, ticketId, response, minutes, responderId } = body;
    const userId = toUserId(body.userId);

    if (typeof id !== 'string' || !ID_PATTERN.test(id)) return bad(res, 'id must be 8-64 letters, digits or hyphens');
    if (!isPositiveInt(ticketId)) return bad(res, 'ticketId must be a positive integer');
    if (!isPositiveInt(userId)) return bad(res, 'userId must be a positive integer');
    if (typeof response !== 'string' || !response.trim() || response.trim().length > MAX_RESPONSE_LENGTH) {
      return bad(res, `response must be 1-${MAX_RESPONSE_LENGTH} characters`);
    }
    const mins = minutes ?? 0;
    if (!Number.isSafeInteger(mins) || mins < 0 || mins > MAX_MINUTES) {
      return bad(res, `minutes must be a whole number between 0 and ${MAX_MINUTES}`);
    }
    if (responderId != null && (typeof responderId !== 'string' || responderId.length > 32)) {
      return bad(res, 'responderId must be a string up to 32 characters');
    }

    const ticket = getTicket.get(ticketId);
    if (!ticket) return res.status(404).json({ error: 'ticket_not_found' });
    if (ticket.user_id !== userId) return bad(res, 'userId does not match the ticket');

    const sameId = getResponseById.get(id);
    if (sameId) {
      if (sameId.ticket_id === ticketId) return res.json({ ok: true, id, duplicate: true });
      return res.status(409).json({ error: 'id_in_use' });
    }
    const existing = getResponseForTicket.get(ticketId);
    if (existing) return res.status(409).json({ error: 'already_answered', responseId: existing.id });

    try {
      saveResponse({
        id,
        ticketId,
        userId,
        response: response.trim(),
        minutes: mins,
        responderId: responderId ?? null,
        createdAt: Date.now(),
      });
    } catch (err) {
      if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
        return res.status(409).json({ error: 'already_answered' });
      }
      throw err;
    }
    log.info(`Response ${id} recorded for ticket #${ticketId}`);
    res.status(201).json({ ok: true, id });
  });

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return bad(res, 'invalid JSON body');
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    log.error('Unhandled request error', err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}