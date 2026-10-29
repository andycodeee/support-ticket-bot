const TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map();

async function fetchJson(url) {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function cachedLookup(key, loader) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await loader();
  if (value !== null) cache.set(key, { value, expires: Date.now() + TTL_MS });
  return value;
}

export function getHeadshotUrl(userId) {
  return cachedLookup(`headshot:${userId}`, async () => {
    const data = await fetchJson(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`,
    );
    return data?.data?.[0]?.imageUrl ?? null;
  });
}

export function getAssetThumbnail(assetId) {
  return cachedLookup(`thumb:${assetId}`, async () => {
    const data = await fetchJson(
      `https://thumbnails.roblox.com/v1/assets?assetIds=${assetId}&returnPolicy=PlaceHolder&size=420x420&format=Png&isCircular=false`,
    );
    return data?.data?.[0]?.imageUrl ?? null;
  });
}

export function getAssetName(assetId) {
  return cachedLookup(`name:${assetId}`, async () => {
    const data = await fetchJson(`https://economy.roblox.com/v2/assets/${assetId}/details`);
    return typeof data?.Name === 'string' && data.Name ? data.Name : null;
  });
}