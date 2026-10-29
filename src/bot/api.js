import { db } from '../db.js';

export class ApiError extends Error {
  constructor(status, body, retryable) {
    super(`API responded ${status}${body?.error ? ` (${body.error})` : ''}`);
    this.status = status;
    this.body = body;
    this.retryable = retryable;
  }
}

const listTickets = db.prepare(`
  SELECT t.id, t.user_id, t.username, t.category, t.explanation, t.status, t.created_at,
         r.response, r.minutes, r.responder_id, r.created_at AS responded_at
  FROM tickets t
  LEFT JOIN responses r ON r.ticket_id = t.id
  WHERE t.id > ?
  ORDER BY t.id ASC
  LIMIT ?
`);

// Used by the bot to find new tickets. Reads the database directly, no HTTP.
export async function fetchTicketsAfter(afterId, limit = 50) {
  return listTickets.all(afterId, limit).map((r) => ({
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
  }));
}

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

// Used by the bot to record an admin response. Same rules as POST /support/responses.
export async function submitResponse({ id, ticketId, userId, response, minutes = 0, responderId = null }) {
  const ticket = getTicket.get(ticketId);
  if (!ticket) throw new ApiError(404, { error: 'ticket_not_found' }, false);
  if (ticket.user_id !== userId) throw new ApiError(400, { error: 'user_mismatch' }, false);

  const sameId = getResponseById.get(id);
  if (sameId) {
    if (sameId.ticket_id === ticketId) return { ok: true, id, duplicate: true };
    throw new ApiError(409, { error: 'id_in_use' }, false);
  }
  const existing = getResponseForTicket.get(ticketId);
  if (existing) throw new ApiError(409, { error: 'already_answered', responseId: existing.id }, false);

  saveResponse({
    id,
    ticketId,
    userId,
    response: response.trim(),
    minutes,
    responderId,
    createdAt: Date.now(),
  });
  return { ok: true, id };
}