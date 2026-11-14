import { config } from '../config.js';
import { getEntry } from './openCloud.js';

export async function fetchPoints(userId) {
  const datastoreName = config.roblox.pointsDatastore;
  if (!datastoreName) return { configured: false, points: null };

  const value = await getEntry({
    datastoreName,
    scope: config.roblox.pointsScope,
    entryKey: String(userId),
  });

  let raw = null;
  if (typeof value === 'number') raw = value;
  else if (value && typeof value === 'object') raw = value.points ?? value.Points ?? value.balance ?? null;

  return { configured: true, points: Number.isFinite(raw) ? Math.floor(raw) : null };
}