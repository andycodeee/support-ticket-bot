import crypto from 'node:crypto';
import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { config } from '../config.js';
import { db } from '../db.js';
import { log } from '../logger.js';
import { MODAL_PREFIX, RESPOND_PREFIX } from './embeds.js';
import { deliverResponse } from './responses.js';

const MAX_MINUTES = 1_000_000_000;
const MAX_RESPONSE_LENGTH = 1000;

const getDiscordTicket = db.prepare('SELECT ticket_id FROM discord_tickets WHERE ticket_id = ?');
const getBotResponse = db.prepare('SELECT * FROM bot_responses WHERE ticket_id = ?');
const insertBotResponse = db.prepare(
  "INSERT INTO bot_responses (id, ticket_id, admin_id, admin_tag, response, minutes, state, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)",
);

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });
const ticketIdFrom = (customId) => Number(customId.slice(customId.indexOf(':') + 1));

/** Only the configured guild, and only admins or configured support roles. */
function isAuthorized(interaction) {
  if (interaction.guildId !== config.discord.guildId) return false;
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  const roles = interaction.member?.roles;
  const roleIds = roles?.cache ? [...roles.cache.keys()] : Array.isArray(roles) ? roles : [];
  return roleIds.some((id) => config.discord.supportRoleIds.includes(id));
}

const NOT_AUTHORIZED = 'You do not have permission to respond to support tickets.';

export async function handleInteraction(client, interaction) {
  if (interaction.isButton() && interaction.customId.startsWith(RESPOND_PREFIX)) {
    return onRespondButton(interaction);
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith(MODAL_PREFIX)) {
    return onModalSubmit(client, interaction);
  }
}

async function onRespondButton(interaction) {
  if (!isAuthorized(interaction)) return interaction.reply(ephemeral(NOT_AUTHORIZED));

  const ticketId = ticketIdFrom(interaction.customId);
  if (!getDiscordTicket.get(ticketId)) return interaction.reply(ephemeral('This ticket is unknown to the bot.'));

  const existing = getBotResponse.get(ticketId);
  if (existing) {
    return interaction.reply(ephemeral(
      existing.state === 'queued'
        ? 'A response to this ticket is already queued and will be sent automatically.'
        : 'This ticket already has a recorded response.',
    ));
  }

  const modal = new ModalBuilder()
    .setCustomId(`${MODAL_PREFIX}${ticketId}`)
    .setTitle(`Respond to Ticket #${ticketId}`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('response')
          .setLabel('Response (sent to the player)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(MAX_RESPONSE_LENGTH),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('minutes')
          .setLabel('Minutes (whole number; empty = 0)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(9)
          .setPlaceholder('0'),
      ),
    );
  await interaction.showModal(modal);
}

async function onModalSubmit(client, interaction) {
  if (!isAuthorized(interaction)) return interaction.reply(ephemeral(NOT_AUTHORIZED));

  // Discord requires an acknowledgement within 3 seconds; the API call can take longer.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const ticketId = ticketIdFrom(interaction.customId);
  const responseText = interaction.fields.getTextInputValue('response').trim();
  const minutesRaw = interaction.fields.getTextInputValue('minutes').trim();

  if (!responseText || responseText.length > MAX_RESPONSE_LENGTH) {
    return interaction.editReply(`Response must be between 1 and ${MAX_RESPONSE_LENGTH} characters.`);
  }

  let minutes = 0;
  if (minutesRaw !== '') {
    if (!/^\d+$/.test(minutesRaw)) {
      return interaction.editReply('Minutes must be a whole number of 0 or more, or left empty for 0.');
    }
    minutes = Number(minutesRaw);
    if (!Number.isSafeInteger(minutes) || minutes > MAX_MINUTES) {
      return interaction.editReply(`Minutes cannot be larger than ${MAX_MINUTES}.`);
    }
  }

  if (!getDiscordTicket.get(ticketId)) return interaction.editReply('This ticket is unknown to the bot.');
  if (getBotResponse.get(ticketId)) return interaction.editReply('This ticket already has a response.');

  const now = Date.now();
  const responseId = crypto.randomUUID();
  try {
    insertBotResponse.run(responseId, ticketId, interaction.user.id, interaction.user.username, responseText, minutes, now, now);
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
      return interaction.editReply('This ticket already has a response.');
    }
    throw err;
  }

  log.info(`Admin ${interaction.user.id} submitted a response for ticket #${ticketId}`);
  const row = await deliverResponse(client, getBotResponse.get(ticketId));

  const messages = {
    sent: 'Response sent. The player will receive it when the game next processes responses.',
    queued: 'The API is unreachable right now. Your response is saved and will be sent automatically.',
    rejected: `The response was not recorded: ${row.last_error}.`,
  };
  return interaction.editReply(messages[row.state] ?? 'Done.');
}
