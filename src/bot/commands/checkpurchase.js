import crypto from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  escapeMarkdown,
} from 'discord.js';
import { config } from '../../config.js';
import { log } from '../../logger.js';
import { OpenCloudError, openCloudConfigured } from '../../roblox/openCloud.js';
import { fetchPurchaseHistory, resolveUserId } from '../../roblox/purchases.js';

const PAGE_SIZE = 8;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 50;
export const PURCHASE_PAGE_PREFIX = 'purchases:';
const NOT_ADMIN = 'Only server administrators can use this command.';

export const checkPurchaseCommand = new SlashCommandBuilder()
  .setName('checkpurchase')
  .setDescription("Show a player's FreeUGC purchase history (admin only)")
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((opt) =>
    opt
      .setName('username')
      .setDescription('Roblox username or numeric UserId')
      .setRequired(true)
      .setMaxLength(64),
  );

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });
const discordTime = (seconds) => `<t:${Math.floor(seconds)}:f>`;
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function isAdmin(interaction) {
  return (
    interaction.guildId === config.discord.guildId &&
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) === true
  );
}

// Short-lived, in-memory cache so page buttons don't re-query Open Cloud.
const cache = new Map();

function remember(state) {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expires < now) cache.delete(key);
  }
  while (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  const token = crypto.randomBytes(6).toString('hex');
  cache.set(token, { ...state, expires: now + CACHE_TTL_MS });
  return token;
}

function recall(token) {
  const entry = cache.get(token);
  if (!entry || entry.expires < Date.now()) {
    cache.delete(token);
    return null;
  }
  return entry;
}

function summarize(entries) {
  let completed = 0;
  let refundedMinutes = 0;
  let notRefunded = 0;
  let malformed = 0;
  for (const e of entries) {
    if (e.kind === 'bad') {
      malformed++;
    } else if (e.status === 'completed') {
      completed++;
    } else if (e.status === 'cancelled' && e.refunded) {
      refundedMinutes += e.cost;
    } else if (e.status === 'cancelled') {
      notRefunded++;
    }
  }
  return { total: entries.length, completed, refundedMinutes, notRefunded, malformed };
}

function formatField(e) {
  if (e.kind === 'bad') {
    return {
      name: '⚠️ Malformed record',
      value: clip(`Entry #${e.index + 1}: ${e.reason}`, 1024),
      inline: false,
    };
  }

  let icon;
  let title;
  if (e.status === 'completed') {
    icon = '🟢';
    title = 'Completed';
  } else if (e.status === 'cancelled' && e.refunded) {
    icon = '🟠';
    title = `Cancelled - Refunded ${e.cost} min`;
  } else if (e.status === 'cancelled') {
    icon = '🔴';
    title = 'Cancelled - NOT REFUNDED';
  } else {
    icon = '⚪';
    title = `Unknown status: ${clip(escapeMarkdown(e.status), 40)}`;
  }

  const asset = e.assetName ? clip(escapeMarkdown(e.assetName), 100) : e.assetId;
  const lines = [discordTime(e.time), `Asset: ${asset}`, `Cost: ${e.cost} min`];
  if (e.source) lines.push(`Source: ${clip(escapeMarkdown(e.source), 40)}`);

  return { name: clip(`${icon} ${title}`, 256), value: clip(lines.join('\n'), 1024), inline: false };
}

function buildPage(state, page) {
  const totalPages = Math.max(1, Math.ceil(state.entries.length / PAGE_SIZE));
  const newestFirst = [...state.entries].reverse();
  const slice = newestFirst.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const s = summarize(state.entries);

  const description = [
    `Records: **${s.total}** · Completed: **${s.completed}**`,
    `Refunded: **${s.refundedMinutes} min** · Not refunded: **${s.notRefunded}**`,
    s.malformed ? `Malformed: **${s.malformed}**` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const problems = s.notRefunded + s.malformed;
  const embed = new EmbedBuilder()
    .setTitle(clip(`Purchase history: ${escapeMarkdown(state.label)}`, 256))
    .setDescription(description)
    .setColor(problems > 0 ? 0xed4245 : 0x57f287)
    .setFooter({ text: `UserId ${state.userId} · Page ${page + 1}/${totalPages} · newest first` })
    .addFields(slice.map(formatField));

  return { embed, totalPages };
}

function pagerRow(token, page, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PURCHASE_PAGE_PREFIX}${token}:${page - 1}`)
      .setLabel('◀ Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`${PURCHASE_PAGE_PREFIX}${token}:${page + 1}`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1),
  );
}

function errorMessage(err) {
  if (err instanceof OpenCloudError) {
    switch (err.code) {
      case 'rate_limited':
        return err.message;
      case 'auth':
        return err.message;
      case 'not_configured':
        return 'Roblox Open Cloud is not configured on this bot.';
      case 'malformed':
        return 'The stored purchase data is malformed and could not be read.';
      default:
        return 'Could not reach Roblox Open Cloud. Try again shortly.';
    }
  }
  return 'Unexpected error while loading purchase history.';
}

export async function executeCheckPurchase(interaction) {
  if (!isAdmin(interaction)) return interaction.reply(ephemeral(NOT_ADMIN));
  if (!openCloudConfigured()) {
    return interaction.reply(ephemeral('Roblox Open Cloud is not configured on this bot.'));
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const input = interaction.options.getString('username', true);

  try {
    const lookup = await resolveUserId(input);
    if (!lookup.ok) {
      if (lookup.reason === 'invalid') {
        return interaction.editReply(
          'Enter a valid Roblox username (3-20 letters, numbers or underscores) or a numeric UserId.',
        );
      }
      return interaction.editReply(`No purchases found for ${escapeMarkdown(input.trim())}`);
    }

    const history = await fetchPurchaseHistory(lookup.userId);
    const label = lookup.byUserId ? `UserId ${lookup.userId}` : lookup.label;

    if (!history.found || history.entries.length === 0) {
      return interaction.editReply(`No purchases found for ${escapeMarkdown(label)}`);
    }

    const state = {
      adminId: interaction.user.id,
      label,
      userId: lookup.userId,
      entries: history.entries,
    };
    const token = remember(state);
    const { embed, totalPages } = buildPage(state, 0);
    return interaction.editReply({ embeds: [embed], components: [pagerRow(token, 0, totalPages)] });
  } catch (err) {
    log.error('/checkpurchase failed', err);
    return interaction.editReply(errorMessage(err));
  }
}

export async function handlePurchasePage(interaction) {
  if (!isAdmin(interaction)) return interaction.reply(ephemeral(NOT_ADMIN));

  const [, token, pageText] = interaction.customId.split(':');
  const state = recall(token);
  if (!state) {
    return interaction.update({
      content: 'This purchase history has expired. Run /checkpurchase again.',
      embeds: [],
      components: [],
    });
  }
  if (state.adminId !== interaction.user.id) {
    return interaction.reply(ephemeral('Only the administrator who ran this lookup can page through it.'));
  }

  const totalPages = Math.max(1, Math.ceil(state.entries.length / PAGE_SIZE));
  const page = Math.min(Math.max(Number(pageText) || 0, 0), totalPages - 1);
  const { embed } = buildPage(state, page);
  return interaction.update({ embeds: [embed], components: [pagerRow(token, page, totalPages)] });
}
