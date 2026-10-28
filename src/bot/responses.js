import { db } from '../db.js';
import { log } from '../logger.js';
import { ApiError, submitResponse } from './api.js';
import { getSupportChannel } from './channel.js';
import { buildRespondRow, buildTicketEmbed } from './embeds.js';

const getDiscordTicket = db.prepare('SELECT * FROM discord_tickets WHERE ticket_id = ?');
const getBotResponse = db.prepare('SELECT * FROM bot_responses WHERE ticket_id = ?');
const setQueued = db.prepare("UPDATE bot_responses SET state = 'queued', last_error = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?");
const setRejected = db.prepare("UPDATE bot_responses SET state = 'rejected', last_error = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?");
const setSent = db.prepare("UPDATE bot_responses SET state = 'sent', last_error = NULL, attempts = attempts + 1, updated_at = ? WHERE id = ?");
const markUpdated = db.prepare('UPDATE bot_responses SET message_updated = 1 WHERE ticket_id = ?');
const pendingRows = db.prepare("SELECT * FROM bot_responses WHERE state = 'queued' ORDER BY created_at ASC");
const unsyncedRows = db.prepare("SELECT ticket_id FROM bot_responses WHERE state IN ('sent', 'rejected') AND message_updated = 0");

/** Re-renders the Discord embed for a ticket (answered view when a response was recorded). */
export async function refreshTicketMessage(client, ticketId) {
  const dt = getDiscordTicket.get(ticketId);
  const br = getBotResponse.get(ticketId);
  if (!dt?.message_id) return;

  const snapshot = JSON.parse(dt.payload);
  const answer = br?.state === 'sent'
    ? { response: br.response, minutes: br.minutes, adminId: br.admin_id, at: br.updated_at }
    : null;
  const notice = br?.state === 'rejected' ? `Response not recorded: ${br.last_error}` : null;

  const channel = await getSupportChannel(client);
  const message = await channel.messages.fetch(dt.message_id).catch(() => null);
  if (message) {
    await message.edit({
      embeds: [buildTicketEmbed(snapshot, answer, notice)],
      components: answer || notice ? [] : [buildRespondRow(ticketId)],
      allowedMentions: { parse: [] },
    });
  } else {
    log.warn(`Ticket #${ticketId}: Discord message ${dt.message_id} not found; skipping edit`);
  }
  if (br) markUpdated.run(ticketId);
}

/**
 * Sends a stored response to the API. The response id is fixed before the first attempt,
 * so retries are idempotent: the API never records the same response twice.
 * Returns the bot_responses row after the attempt (state: 'sent' | 'queued' | 'rejected').
 */
export async function deliverResponse(client, row) {
  const dt = getDiscordTicket.get(row.ticket_id);
  try {
    await submitResponse({
      id: row.id,
      ticketId: row.ticket_id,
      userId: dt.user_id,
      response: row.response,
      minutes: row.minutes,
      responderId: row.admin_id,
    });
    setSent.run(Date.now(), row.id);
    log.info(`Response ${row.id} recorded by API for ticket #${row.ticket_id}`);
  } catch (err) {
    if (err instanceof ApiError && !err.retryable) {
      const reason = err.body?.error === 'already_answered'
        ? 'this ticket was already answered'
        : `API rejected the response (HTTP ${err.status})`;
      setRejected.run(reason, Date.now(), row.id);
      log.warn(`Response ${row.id} for ticket #${row.ticket_id} rejected: ${reason}`);
    } else {
      setQueued.run(err.message, Date.now(), row.id);
      log.warn(`Response ${row.id} for ticket #${row.ticket_id} queued for retry`);
      return getBotResponse.get(row.ticket_id);
    }
  }

  try {
    await refreshTicketMessage(client, row.ticket_id);
  } catch (err) {
    log.warn(`Could not update Discord message for ticket #${row.ticket_id}; will retry`, err);
  }
  return getBotResponse.get(row.ticket_id);
}

/** Each poll cycle: resend queued responses and fix up any stale Discord messages. */
export async function retryPending(client) {
  for (const row of pendingRows.all()) {
    await deliverResponse(client, row);
  }
  for (const { ticket_id } of unsyncedRows.all()) {
    await refreshTicketMessage(client, ticket_id).catch((err) =>
      log.warn(`Could not update Discord message for ticket #${ticket_id}; will retry`, err),
    );
  }
}
