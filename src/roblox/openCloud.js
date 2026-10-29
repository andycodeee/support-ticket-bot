import { config } from '../config.js';

const MAX_ATTEMPTS = 3;
const BASE_URL = 'https://apis.roblox.com/datastores/v1/universes';

export class OpenCloudError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function openCloudConfigured() {
  return Boolean(config.roblox.apiKey && config.roblox.universeId);
}

/**
 * Reads one standard DataStore entry over Open Cloud. Returns the parsed value,
 * or null if the entry does not exist. Works for offline players; no game server needed.
 */
export async function getEntry({ datastoreName, scope = 'global', entryKey }) {
  if (!openCloudConfigured()) {
    throw new OpenCloudError('not_configured', 'Roblox Open Cloud is not configured');
  }

  const params = new URLSearchParams({ datastoreName, scope, entryKey });
  const url = `${BASE_URL}/${config.roblox.universeId}/standard-datastores/datastore/entries/entry?${params}`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { 'x-api-key': config.roblox.apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      if (attempt === MAX_ATTEMPTS) throw new OpenCloudError('network', 'Could not reach Roblox Open Cloud');
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }

    if (res.status === 404) return null;

    if (res.status === 429) {
      const retryAfter = Math.min(Number(res.headers.get('retry-after')) || 10, 300);
      throw new OpenCloudError('rate_limited', `Roblox rate limit reached. Try again in ${retryAfter}s.`, 429);
    }

    if (res.status === 401 || res.status === 403) {
      throw new OpenCloudError(
        'auth',
        'Roblox rejected the Open Cloud API key. Check that it is valid, has DataStore read access, and that its IP allowlist permits this server.',
        res.status,
      );
    }

    if (res.status >= 500) {
      if (attempt === MAX_ATTEMPTS) throw new OpenCloudError('api', `Open Cloud returned HTTP ${res.status}`, res.status);
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }

    if (!res.ok) throw new OpenCloudError('api', `Open Cloud returned HTTP ${res.status}`, res.status);

    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new OpenCloudError('malformed', 'Stored entry is not valid JSON', res.status);
    }
  }
  throw new OpenCloudError('network', 'Could not reach Roblox Open Cloud');
}
