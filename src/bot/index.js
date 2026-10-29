import { Client, Events, GatewayIntentBits, MessageFlags, PermissionsBitField } from 'discord.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import { executeCheckPurchase, handlePurchasePage, PURCHASE_PAGE_PREFIX } from './commands/checkpurchase.js';
import { registerCommands } from './commands/index.js';
import { getSupportChannel } from './channel.js';
import { handleInteraction } from './interactions.js';
import { startPoller } from './poller.js';

async function route(client, interaction) {
  if (interaction.isChatInputCommand() && interaction.commandName === 'checkpurchase') {
    return executeCheckPurchase(interaction);
  }
  if (interaction.isButton() && interaction.customId.startsWith(PURCHASE_PAGE_PREFIX)) {
    return handlePurchasePage(interaction);
  }
  return handleInteraction(client, interaction);
}

export async function startBot() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.on(Events.InteractionCreate, (interaction) => {
    route(client, interaction).catch(async (err) => {
      log.error('Interaction handler failed', err);
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction
          .reply({ content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral })
          .catch(() => {});
      } else if (interaction.isRepliable() && interaction.deferred) {
        await interaction.editReply('Something went wrong. Please try again.').catch(() => {});
      }
    });
  });

  const ready = new Promise((resolve) => client.once(Events.ClientReady, resolve));
  await client.login(config.discord.token);
  const readyClient = await ready;
  log.info(`Discord bot ready as ${readyClient.user.tag}`);

  const permissions = new PermissionsBitField([
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.EmbedLinks,
    PermissionsBitField.Flags.ReadMessageHistory,
  ]).bitfield;
  log.info(
    `Invite URL (first setup only): https://discord.com/oauth2/authorize?client_id=${config.discord.clientId}&scope=bot+applications.commands&permissions=${permissions}`,
  );

  try {
    await registerCommands();
  } catch (err) {
    log.error('Slash command registration failed. If you just added commands, re-invite the bot with the applications.commands scope.', err);
  }

  await getSupportChannel(client);
  startPoller(client);
  return client;
}
