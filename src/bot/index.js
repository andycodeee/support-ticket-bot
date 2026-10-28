import { Client, Events, GatewayIntentBits, MessageFlags, PermissionsBitField } from 'discord.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import { getSupportChannel } from './channel.js';
import { handleInteraction } from './interactions.js';
import { startPoller } from './poller.js';

export async function startBot() {
  // Guilds intent only: no privileged intents (no Message Content) are needed.
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.on(Events.InteractionCreate, (interaction) => {
    handleInteraction(client, interaction).catch(async (err) => {
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
  log.info(`Invite URL (first setup only): https://discord.com/oauth2/authorize?client_id=${config.discord.clientId}&scope=bot&permissions=${permissions}`);

  // Fail fast if the support channel is misconfigured.
  await getSupportChannel(client);
  startPoller(client);
  return client;
}
