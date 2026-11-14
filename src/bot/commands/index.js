import { REST, Routes } from 'discord.js';
import { config } from '../../config.js';
import { log } from '../../logger.js';
import { checkPurchaseCommand } from './checkpurchase.js';

export const commands = [checkPurchaseCommand];

/** Registers slash commands to the configured guild. Safe to run on every startup. */
export async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  await rest.put(
    Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId),
    { body: commands.map((c) => c.toJSON()) },
  );
  log.info(`Registered ${commands.length} slash command(s) for the guild`);
}
