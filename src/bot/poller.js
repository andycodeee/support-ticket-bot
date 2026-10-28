import { config } from '../config.js';
import { db } from '../db.js';
import { log } from '../logger.js';
import { fetchTicketsAfter } from './api.js';
import { getSupportChannel } from './channel.js';
import { buildRespondRow, buildTicketEmbed, RESPOND_PREFIX } from './embeds.js';
import { retryPending } from './responses.js';

const getCursor = db.prepare("SELECT value FROM kv WHERE key = 'ticket_cursor'");
const setCursor = db.prepare(
  "INSERT INTO kv (key, value) VALUES ('ticket_cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);
const getDiscordTicket = db.prepare('SELECT * FROM discord_tickets WHERE ticket_id = ?');
const insertDiscordTicket = db.prepare(
  'INSERT OR IGNORE INTO discord_tickets (ticket_id, user_id, channel_id, payload) VALUES (?, ?, ?, ?)',
);
const setPosted = db.prepare('UPDATE discord_tickets SET message_id = ?, posted_at = ? WHERE ticket_id = ?');

/** Finds a message we posted earlier for this ticket (covers a crash between send and DB write). */
async function findExistingMessage(channel, ticketId) {
  const customId = `${RESPOND_PREFIX}${ticketId}`;
  const messages = await channel.messages.fetch({ limit: 100 });
  return messages.find(
    (m) => m.author.id === channel.client.user.id &&
      m.components.some((row) => row.components.some((c) => c.customId === customId)),
  ) ?? null;
}

async function processTicket(client, ticket) {
  const existing = getDiscordTicket.get(ticket.id);
  if (existing?.message_id) return;

  const channel = await getSupportChannel(client);
  const snapshot = {
    id: ticket.id,
    userId: ticket.userId,
    username: ticket.username,
    category: ticket.category,
    explanation: ticket.explanation,
    createdAt: ticket.createdAt,
  };
  insertDiscordTicket.run(ticket.id, ticket.userId, channel.id, JSON.stringify(snapshot));

  let message = existing ? await findExistingMessage(channel, ticket.id) : null;
  if (!message) {
    const answer = ticket.response
      ? { response: ticket.response, minutes: ticket.minutes, adminId: ticket.responderId, at: ticket.respondedAt }
      : null;
    message = await channel.send({
      embeds: [buildTicketEmbed(snapshot, answer)],
      components: answer ? [] : [buildRespondRow(ticket.id)],
      allowedMentions: { parse: [] },
    });
  }
  setPosted.run(message.id, Date.now(), ticket.id);
  log.info(`Posted ticket #${ticket.id} to Discord`);
}

async function syncTickets(client) {
  let cursor = Number(getCursor.get()?.value ?? 0);
  for (;;) {
    const tickets = await fetchTicketsAfter(cursor);
    for (const ticket of tickets) {
      await processTicket(client, ticket);
      setCursor.run(String(ticket.id));
      cursor = ticket.id;
    }
    if (tickets.length < 50) break;
  }
}

export function startPoller(client) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await syncTickets(client);
    } catch (err) {
      log.error('Ticket sync failed; will retry next cycle', err);
    }
    try {
      await retryPending(client);
    } catch (err) {
      log.error('Response retry failed; will retry next cycle', err);
    } finally {
      busy = false;
    }
  };
  tick();
  setInterval(tick, config.pollIntervalMs);
  log.info(`Polling API every ${config.pollIntervalMs} ms`);
}
