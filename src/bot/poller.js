import crypto from 'node:crypto';
import { config } from '../config.js';
import { db } from '../db.js';
import { log } from '../logger.js';
import { fetchTicketsAfter } from './api.js';
import { getChannelById, getChannelForCategory } from './channel.js';
import { analyzeTicket } from './ai.js';
import { buildRespondRow, buildTicketEmbed, RESPOND_PREFIX } from './embeds.js';
import { deliverResponse, retryPending } from './responses.js';

const AI_AUTO_REPLY_CATEGORIES = new Set(['free_ugc', 'gameplay_help', 'suggestion', 'spam', 'unclear']);

const getCursor = db.prepare("SELECT value FROM kv WHERE key = 'ticket_cursor'");
const setCursor = db.prepare(
  "INSERT INTO kv (key, value) VALUES ('ticket_cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);
const getDiscordTicket = db.prepare('SELECT * FROM discord_tickets WHERE ticket_id = ?');
const insertDiscordTicket = db.prepare(
  'INSERT OR IGNORE INTO discord_tickets (ticket_id, user_id, channel_id, payload) VALUES (?, ?, ?, ?)',
);
const setPosted = db.prepare('UPDATE discord_tickets SET message_id = ?, posted_at = ? WHERE ticket_id = ?');
const getBotResponse = db.prepare('SELECT * FROM bot_responses WHERE ticket_id = ?');
const insertAiResponse = db.prepare(
  "INSERT OR IGNORE INTO bot_responses (id, ticket_id, admin_id, admin_tag, response, minutes, state, attempts, created_at, updated_at) VALUES (?, ?, 'ai', 'Books Cover AI', ?, 0, 'queued', 0, ?, ?)",
);

/** Finds a message we posted earlier for this ticket (covers a crash between send and DB write). */
async function findExistingMessage(channel, ticketId) {
  const customId = `${RESPOND_PREFIX}${ticketId}`;
  const messages = await channel.messages.fetch({ limit: 100 });
  return messages.find(
    (m) => m.author.id === channel.client.user.id &&
      m.components.some((row) => row.components.some((c) => c.customId === customId)),
  ) ?? null;
}

function makeSnapshot(ticket) {
  return {
    id: ticket.id,
    userId: ticket.userId,
    username: ticket.username,
    category: ticket.category,
    explanation: ticket.explanation,
    createdAt: ticket.createdAt,
  };
}

async function processTicket(client, ticket) {
  const existing = getDiscordTicket.get(ticket.id);

  // Use the recorded category-specific channel; recover safely after a send/DB-write crash.
  const channel = existing?.channel_id
    ? await getChannelById(client, existing.channel_id)
    : await getChannelForCategory(client, ticket.category);
  const ticketSnapshot = makeSnapshot(ticket);
  let snapshot = existing?.payload ? JSON.parse(existing.payload) : ticketSnapshot;
  if (
    config.ai.enabled &&
    !ticket.response &&
    !existing?.message_id &&
    !snapshot.aiCategory
  ) {
    try {
      const analysis = await analyzeTicket(ticketSnapshot);
      if (!analysis) throw new Error('AI analysis returned no result');
      snapshot = { ...ticketSnapshot, ...analysis };
    } catch (err) {
      log.warn(`AI analysis unavailable for ticket #${ticket.id}; it will not be posted until analysis succeeds`, err);
      return false;
    }
  }
  insertDiscordTicket.run(ticket.id, ticket.userId, channel.id, JSON.stringify(snapshot));

  let message = existing?.message_id
    ? await channel.messages.fetch(existing.message_id).catch(() => null)
    : existing ? await findExistingMessage(channel, ticket.id) : null;
  if (!message) {
    const answer = ticket.response
      ? { response: ticket.response, minutes: ticket.minutes, adminId: ticket.responderId, at: ticket.respondedAt }
      : null;
    message = await channel.send({
      embeds: [buildTicketEmbed(snapshot, answer)],
      components: answer ? [] : [buildRespondRow(ticket.id, Boolean(snapshot.aiSuggestedResponse))],
      allowedMentions: { parse: [] },
    });
  }
  setPosted.run(message.id, Date.now(), ticket.id);
  if (!existing?.message_id) log.info(`Posted ticket #${ticket.id} (${ticket.category}) to Discord`);

  if (
    config.ai.enabled &&
    config.ai.autoReply &&
    !ticket.response &&
    AI_AUTO_REPLY_CATEGORIES.has(snapshot.aiCategory) &&
    snapshot.aiSuggestedResponse
  ) {
    const now = Date.now();
    const inserted = insertAiResponse.run(crypto.randomUUID(), ticket.id, snapshot.aiSuggestedResponse, now, now);
    if (inserted.changes > 0) {
      log.info(`Sending approved AI reply for ticket #${ticket.id} (${snapshot.aiCategory})`);
      await deliverResponse(client, getBotResponse.get(ticket.id));
    }
  }
  return true;
}

async function syncTickets(client) {
  let cursor = Number(getCursor.get()?.value ?? 0);
  for (;;) {
    const tickets = await fetchTicketsAfter(cursor);
    for (const ticket of tickets) {
      const processed = await processTicket(client, ticket);
      if (!processed) return;
      setCursor.run(String(ticket.id));
      cursor = ticket.id;
    }
    if (tickets.length < 50) break;
  }
}

export function startPoller(client) {
  if (config.discord.otherChannelId === '') {
    log.info('OTHER_SUPPORT_CHANNEL_ID not set: "Other" tickets will go to the support channel');
  }

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
