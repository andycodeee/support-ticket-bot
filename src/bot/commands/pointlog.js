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
import { fetchPointLog } from '../../roblox/points.js';
import { lookupUsername } from '../../roblox/publicApis.js';

const PAGE_SIZE = 10;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 50;
const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;
export const POINT_LOG_PAGE_PREFIX = 'pointlog:';
const NOT_ADMIN = 'Only server administrators can use this command.';

export const pointLogCommand = new SlashCommandBuilder()
  .setName('pointlog')
  .setDescription("Show a player's point history (admin only)")
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((opt) =>
    opt
      .setName('user')
      .setDescription('Roblox username or numeric UserId')
      .setRequired(true)
      .setMaxLength(64),
  );

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });
const formatTime = (seconds) => `<t:${Math.floor(seconds)}:f>`;
const formatNumber = (n) => n.toLocaleString('en-US');
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function isAdmin(interaction) {
  return (
    interaction.guildId === config.discord.guildId &&
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) === true
  );
}

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

function buildPage(state, page) {
  const totalPages = Math.max(1, Math.ceil(state.entries.length / PAGE_SIZE));
  const start = page * PAGE_SIZE;
  const entries = [...state.entries].reverse().slice(start, start + PAGE_SIZE);
  const lines = entries.map((entry, index) => {
    if (entry.kind === 'bad') return `**#${state.entries.length - start - index}** ⚠️ Malformed log entry`;
    const sign = entry.amount > 0 ? '+' : '';
    const amount = `${sign}${formatNumber(entry.amount)}`;
    const reason = clip(escapeMarkdown(entry.reason), 180) || 'No reason provided';
    return `**${formatTime(entry.time)}** · ${amount} points · Balance: ${formatNumber(entry.balance)}\n${reason}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`📋 Point log · ${escapeMarkdown(state.label)}`)
    .setURL(`https://www.roblox.com/users/${state.userId}/profile`)
    .setColor(0x5865f2)
    .setDescription(lines.join('\n\n') || 'No point-log entries were recorded.')
    .setFooter({ text: `Newest first · ${state.entries.length} entries · Page ${page + 1}/${totalPages}` });
  return { embed, totalPages };
}

function pagerRow(token, page, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${POINT_LOG_PAGE_PREFIX}${token}:${page - 1}`)
      .setLabel('◀ Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`${POINT_LOG_PAGE_PREFIX}${token}:${page + 1}`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1),
  );
}

function errorMessage(err) {
  if (err instanceof OpenCloudError) {
    if (err.code === 'not_configured') return 'Roblox Open Cloud is not configured on this bot.';
    if (err.code === 'rate_limited' || err.code === 'auth') return err.message;
    if (err.code === 'malformed') return 'The stored player profile is malformed and could not be read.';
    return 'Could not reach Roblox Open Cloud. Try again shortly.';
  }
  return 'Unexpected error while loading the point log.';
}

async function resolvePlayer(input) {
  const raw = input.trim().replace(/^@/, '');
  if (/^\d+$/.test(raw)) {
    const userId = Number(raw);
    if (Number.isSafeInteger(userId) && userId > 0) return { userId, label: `UserId ${userId}` };
    return null;
  }
  if (!USERNAME_PATTERN.test(raw)) return null;
  const user = await lookupUsername(raw);
  return user ? { userId: user.id, label: user.name || raw } : null;
}

export async function executePointLog(interaction) {
  if (!isAdmin(interaction)) return interaction.reply(ephemeral(NOT_ADMIN));
  if (!openCloudConfigured()) {
    return interaction.reply(ephemeral('Roblox Open Cloud is not configured on this bot.'));
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const input = interaction.options.getString('user', true);

  try {
    const player = await resolvePlayer(input);
    if (!player) {
      return interaction.editReply('Enter a valid Roblox username or numeric UserId.');
    }

    const result = await fetchPointLog(player.userId);
    if (!result.found) return interaction.editReply(`No saved player profile found for ${escapeMarkdown(player.label)}.`);
    if (result.malformed) {
      return interaction.editReply('The profile exists, but it does not contain a valid Data.PointLog array.');
    }

    const state = {
      adminId: interaction.user.id,
      label: player.label,
      userId: player.userId,
      entries: result.entries,
    };
    const token = remember(state);
    const { embed, totalPages } = buildPage(state, 0);
    return interaction.editReply({ embeds: [embed], components: [pagerRow(token, 0, totalPages)] });
  } catch (err) {
    log.error('/pointlog failed', err);
    return interaction.editReply(errorMessage(err));
  }
}

export async function handlePointLogPage(interaction) {
  if (!isAdmin(interaction)) return interaction.reply(ephemeral(NOT_ADMIN));

  const [, token, pageText] = interaction.customId.split(':');
  const state = recall(token);
  if (!state) {
    return interaction.update({
      content: 'This point log has expired. Run /pointlog again.',
      embeds: [],
      components: [],
    });
  }
  if (state.adminId !== interaction.user.id) {
    return interaction.reply(ephemeral('Only the administrator who ran this lookup can browse it.'));
  }

  const totalPages = Math.max(1, Math.ceil(state.entries.length / PAGE_SIZE));
  const page = Math.min(Math.max(Number(pageText) || 0, 0), totalPages - 1);
  const { embed } = buildPage(state, page);
  return interaction.update({ embeds: [embed], components: [pagerRow(token, page, totalPages)] });
}
