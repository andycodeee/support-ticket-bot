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
import { getAssetName, getAssetThumbnail, getHeadshotUrl } from '../../roblox/publicAPIs.js';
import { fetchPoints } from '../../roblox/points.js';
import { fetchPurchaseHistory, resolveUserId } from '../../roblox/purchases.js';

const PAGE_SIZE = 5;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 50;
export const PURCHASE_PAGE_PREFIX = 'purchases:';
const NOT_ADMIN = 'Only server administrators can use this command.';

const EMOJI = {
  completed: '<:b_whitecheck:1565443556024389764>',
  cancelled: '<a:dr_redX_No:1565443712480182436>',
  refund: '<:refund:1565444503857266859>',
  notRefunded: '<:b_whitex:1565444638217609236>',
  malformed: '<:685108warn:1565446431928750172>',
  unknown: '<a:dc_questionMark:1565447526436573324>',
  points: '<:b3f1fd249969462596a6df77c4d7c6de:1565447274677403699>',
};

export const checkPurchaseCommand = new SlashCommandBuilder()
  .setName('checkpurchase')
  .setDescription("Show a player's profile and full FreeUGC purchase history (admin only)")
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
const profileUrl = (userId) => `https://www.roblox.com/users/${userId}/profile`;
const catalogUrl = (assetId) => `https://www.roblox.com/catalog/${assetId}`;

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

function computeStats(entries) {
  const s = {
    total: entries.length,
    completed: 0,
    completedMinutes: 0,
    cancelled: 0,
    refunded: 0,
    refundedMinutes: 0,
    notRefunded: 0,
    notRefundedMinutes: 0,
    malformed: 0,
    firstTime: null,
    lastTime: null,
  };

  for (const e of entries) {
    if (e.kind === 'bad') {
      s.malformed++;
      continue;
    }
    if (s.firstTime === null || e.time < s.firstTime) s.firstTime = e.time;
    if (s.lastTime === null || e.time > s.lastTime) s.lastTime = e.time;

    if (e.status === 'completed') {
      s.completed++;
      s.completedMinutes += e.cost;
    } else if (e.status === 'cancelled') {
      s.cancelled++;
      if (e.refunded) {
        s.refunded++;
        s.refundedMinutes += e.cost;
      } else {
        s.notRefunded++;
        s.notRefundedMinutes += e.cost;
      }
    }
  }
  return s;
}

function describe(e) {
  if (e.status === 'completed') {
    return { icon: EMOJI.completed, text: `${EMOJI.completed} Completed`, color: 0x57f287 };
  }
  if (e.status === 'cancelled' && e.refunded) {
    return {
      icon: EMOJI.cancelled,
      text: `${EMOJI.refund} Cancelled - Refunded ${e.cost} min`,
      color: 0xfaa61a,
    };
  }
  if (e.status === 'cancelled') {
    return {
      icon: EMOJI.cancelled,
      text: `${EMOJI.notRefunded} Cancelled - NOT REFUNDED`,
      color: 0xed4245,
    };
  }
  return {
    icon: EMOJI.unknown,
    text: `Unknown status: ${clip(escapeMarkdown(e.status), 40)}`,
    color: 0x99aab5,
  };
}

function formatPoints(p) {
  if (!p.configured) return 'Not configured (set POINTS_DATASTORE)';
  if (p.points === null) return 'Unknown';
  return p.points.toLocaleString('en-US');
}

function totalPagesFor(state) {
  return 1 + Math.ceil(state.entries.length / PAGE_SIZE);
}

function buildProfileEmbed(state, s, totalPages, headshot) {
  const problems = s.notRefunded > 0 || s.malformed > 0;
  const embed = new EmbedBuilder()
    .setTitle(clip(`🧾 ${escapeMarkdown(state.label)}`, 256))
    .setURL(profileUrl(state.userId))
    .setColor(problems ? 0xed4245 : 0x57f287)
    .setFooter({ text: `Profile · Page 1/${totalPages} · Use Next to browse purchases` })
    .addFields(
      { name: 'Username', value: escapeMarkdown(state.label), inline: true },
      { name: 'UserId', value: String(state.userId), inline: true },
      { name: `${EMOJI.points} Points`, value: formatPoints(state.points), inline: true },
      { name: 'Total records', value: String(s.total), inline: true },
      { name: `${EMOJI.completed} Completed`, value: `${s.completed} (${s.completedMinutes} min spent)`, inline: true },
      { name: `${EMOJI.cancelled} Cancelled`, value: String(s.cancelled), inline: true },
      { name: `${EMOJI.refund} Refunded`, value: `${s.refunded} (${s.refundedMinutes} min)`, inline: true },
      { name: `${EMOJI.notRefunded} Not refunded`, value: `${s.notRefunded} (${s.notRefundedMinutes} min)`, inline: true },
      { name: `${EMOJI.malformed} Malformed`, value: String(s.malformed), inline: true },
      { name: 'First purchase', value: s.firstTime !== null ? discordTime(s.firstTime) : 'n/a', inline: true },
      { name: 'Latest purchase', value: s.lastTime !== null ? discordTime(s.lastTime) : 'n/a', inline: true },
    );
  if (headshot) embed.setThumbnail(headshot);
  return embed;
}

function buildPurchaseEmbed(e, extras) {
  if (e.kind === 'bad') {
    return new EmbedBuilder()
      .setTitle(`${EMOJI.malformed} Malformed record`)
      .setDescription(clip(`Entry #${e.index + 1}: ${e.reason}`, 4000))
      .setColor(0x99aab5)
      .setFooter({ text: extras.footer });
  }

  const d = describe(e);
  const name = e.assetName || extras.name || `Asset ${e.assetId}`;
  const lines = [`**${d.text}**`, discordTime(e.time), `Cost: ${e.cost} min`, `Asset ID: ${e.assetId}`];
  if (e.source) lines.push(`Source: ${clip(escapeMarkdown(e.source), 40)}`);

  const embed = new EmbedBuilder()
    .setTitle(clip(`${d.icon} ${escapeMarkdown(name)}`, 256))
    .setURL(catalogUrl(e.assetId))
    .setDescription(lines.join('\n'))
    .setColor(d.color)
    .setFooter({ text: extras.footer });
  if (extras.thumb) embed.setThumbnail(extras.thumb);
  return embed;
}

async function buildPage(state, page) {
  const totalPages = totalPagesFor(state);

  if (page === 0) {
    const stats = computeStats(state.entries);
    const headshot = await getHeadshotUrl(state.userId).catch(() => null);
    return { embeds: [buildProfileEmbed(state, stats, totalPages, headshot)], totalPages };
  }

  const newestFirst = [...state.entries].reverse();
  const start = (page - 1) * PAGE_SIZE;
  const slice = newestFirst.slice(start, start + PAGE_SIZE);

  const extras = await Promise.all(
    slice.map(async (e, i) => {
      const footer = `Purchase ${start + i + 1} of ${state.entries.length} · newest first · Page ${page + 1}/${totalPages}`;
      if (e.kind !== 'ok') return { footer };
      const [thumb, name] = await Promise.all([
        getAssetThumbnail(e.assetId).catch(() => null),
        e.assetName ? Promise.resolve(null) : getAssetName(e.assetId).catch(() => null),
      ]);
      return { thumb, name, footer };
    }),
  );

  const embeds = slice.map((e, i) => buildPurchaseEmbed(e, extras[i]));
  return { embeds, totalPages };
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

    const points = await fetchPoints(lookup.userId).catch((err) => {
      log.warn('Points lookup failed', err);
      return { configured: true, points: null };
    });

    const state = {
      adminId: interaction.user.id,
      label,
      userId: lookup.userId,
      entries: history.entries,
      points,
    };
    const token = remember(state);
    const { embeds, totalPages } = await buildPage(state, 0);
    return interaction.editReply({ embeds, components: [pagerRow(token, 0, totalPages)] });
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

  const totalPages = totalPagesFor(state);
  const page = Math.min(Math.max(Number(pageText) || 0, 0), totalPages - 1);
  const { embeds } = await buildPage(state, page);
  return interaction.update({ embeds, components: [pagerRow(token, page, totalPages)] });
}