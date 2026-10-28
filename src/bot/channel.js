import { config } from '../config.js';

export async function getSupportChannel(client) {
  const channel = await client.channels.fetch(config.discord.supportChannelId);
  if (!channel || !channel.isTextBased() || channel.guildId !== config.discord.guildId) {
    throw new Error('Support channel is missing, not text-based, or not in the configured guild');
  }
  return channel;
}
