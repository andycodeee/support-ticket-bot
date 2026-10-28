import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown } from 'discord.js';

export const RESPOND_PREFIX = 'respond:';
export const MODAL_PREFIX = 'modal:';

const clip = (text, max = 1024) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const discordTime = (ms) => `<t:${Math.floor(ms / 1000)}:f>`;

/**
 * @param ticket  {id, userId, username, category, explanation, createdAt}
 * @param answer  null | {response, minutes, adminId, at}
 * @param notice  optional string shown as a field (used when a response was rejected)
 */
export function buildTicketEmbed(ticket, answer, notice = null) {
  const embed = new EmbedBuilder()
    .setTitle(`Support Ticket #${ticket.id}`)
    .setColor(answer ? 0x57f287 : 0xfaa61a)
    .addFields(
      { name: 'Player', value: clip(escapeMarkdown(ticket.username)), inline: true },
      { name: 'User ID', value: String(ticket.userId), inline: true },
      { name: 'Category', value: ticket.category, inline: true },
      { name: 'Explanation', value: clip(escapeMarkdown(ticket.explanation)) },
      { name: 'Submitted', value: discordTime(ticket.createdAt), inline: true },
      { name: 'Status', value: answer ? '✅ Answered' : '🟡 Pending', inline: true },
    );

  if (answer) {
    embed.addFields(
      { name: 'Response', value: clip(escapeMarkdown(answer.response)) },
      { name: 'Minutes', value: String(answer.minutes), inline: true },
      { name: 'Answered By', value: answer.adminId ? `<@${answer.adminId}>` : 'Unknown', inline: true },
      { name: 'Answered At', value: discordTime(answer.at), inline: true },
    );
  }
  if (notice) {
    embed.addFields({ name: 'Notice', value: clip(escapeMarkdown(notice)) });
  }
  return embed;
}

export function buildRespondRow(ticketId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${RESPOND_PREFIX}${ticketId}`)
      .setLabel('Send Response')
      .setStyle(ButtonStyle.Primary),
  );
}
