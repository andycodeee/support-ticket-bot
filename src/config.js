import 'dotenv/config';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function intEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

export const config = Object.freeze({
  port: intEnv('PORT', 3000),
  dbPath: process.env.DB_PATH?.trim() || './data/support.sqlite',
  apiSecret: required('API_SECRET'),
  apiBaseUrl: (process.env.API_BASE_URL?.trim() || 'https://api.bookscover.store').replace(/\/+$/, ''),
  pollIntervalMs: Math.max(2000, intEnv('POLL_INTERVAL_MS', 10000)),
  discord: Object.freeze({
    token: required('DISCORD_TOKEN'),
    clientId: required('DISCORD_CLIENT_ID'),
    guildId: required('DISCORD_GUILD_ID'),
    supportChannelId: required('SUPPORT_CHANNEL_ID'),
    supportRoleIds: (process.env.SUPPORT_ROLE_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  }),
  roblox: Object.freeze({
    apiKey: process.env.ROBLOX_API_KEY?.trim() || '',
    universeId: process.env.ROBLOX_UNIVERSE_ID?.trim() || '',
    pointsDatastore: process.env.POINTS_DATASTORE?.trim() || '',
    pointsScope: process.env.POINTS_SCOPE?.trim() || 'global',
  }),
});
