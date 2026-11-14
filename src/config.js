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

function boolEnv(name, fallback) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

export const config = Object.freeze({
  port: intEnv('PORT', 3000),
  dbPath: process.env.DB_PATH?.trim() || './data/support.sqlite',
  apiSecret: required('API_SECRET'),
  apiBaseUrl: (process.env.API_BASE_URL?.trim() || 'https://api.bookscover.store').replace(/\/+$/, ''),
  pollIntervalMs: Math.max(2000, intEnv('POLL_INTERVAL_MS', 10000)),
  ai: Object.freeze({
    enabled: boolEnv('AI_ENABLED', false),
    autoReply: boolEnv('AI_AUTO_REPLY', true),
    provider: (process.env.AI_PROVIDER?.trim().toLowerCase() || 'ollama'),
    baseUrl: (process.env.AI_BASE_URL?.trim() || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
    model: process.env.AI_MODEL?.trim() || (process.env.AI_PROVIDER?.trim().toLowerCase() === 'gemini' ? 'gemini-4-hydrogen' : 'qwen2.5:3b'),
    apiKey: process.env.AI_API_KEY?.trim() || '',
    timeoutMs: Math.max(1000, intEnv('AI_TIMEOUT_MS', 30000)),
  }),
  discord: Object.freeze({
    token: required('DISCORD_TOKEN'),
    clientId: required('DISCORD_CLIENT_ID'),
    guildId: required('DISCORD_GUILD_ID'),
    supportChannelId: required('SUPPORT_CHANNEL_ID'),
    // Optional. Tickets in the "Other" category go here. If unset, they go to the support channel.
    otherChannelId: process.env.OTHER_SUPPORT_CHANNEL_ID?.trim() || '',
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

if (!['ollama', 'gemini'].includes(config.ai.provider)) {
  throw new Error('AI_PROVIDER must be ollama or gemini');
}
if (config.ai.enabled && config.ai.provider === 'gemini' && !config.ai.apiKey) {
  throw new Error('AI_API_KEY is required when AI_ENABLED=true and AI_PROVIDER=gemini');
}
