import express from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { db } from '../db.js';
import { log } from '../logger.js';

export const CATEGORIES = ['Report', 'FailedPurcahse', 'Bug'];

const LEASE_MS = 60_000;
const DUPLICATE_WINDOW_MS = 30_000;
const MAX_MINUTES = 1_000_000_000;
const MAX_RESPONSE_LENGTH = 1000;
const MAX_EXPLANATION_LENGTH = 1000;
const ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

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
  app.use(express.json({ limit: '32kb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, build: 'string-userid-v2' }));

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