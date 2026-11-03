import { config } from '../config.js';

export async function getChannelById(client, channelId) {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || channel.guildId !== config.discord.guildId) {
    throw new Error(`Channel ${channelId} is missing, not text-based, or not in the configured guild`);
  }
  return channel;
}

/** "Other" goes to its own channel when configured; everything else to the support channel. */
export function channelIdForCategory(category) {
  if (category === 'Other' && config.discord.otherChannelId) return config.discord.otherChannelId;
  return config.discord.supportChannelId;
}

export function getSupportChannel(client) {
  return getChannelById(client, config.discord.supportChannelId);
}

export function getChannelForCategory(client, category) {
  return getChannelById(client, channelIdForCategory(category));
}
