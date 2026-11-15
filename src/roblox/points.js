import { config } from '../config.js';
import { getEntry } from './openCloud.js';

export async function fetchPoints(userId) {
  const datastoreName = config.roblox.pointsDatastore;
  const value = datastoreName
    ? await getEntry({
      datastoreName,
      scope: config.roblox.pointsScope,
      entryKey: String(userId),
    })
    : await getProfileEntry(userId).catch((err) => {
      if (err.code === 'not_configured') return null;
      throw err;
    });
  if (!datastoreName && value === null) return { configured: false, points: null };

  let raw = null;
  if (typeof value === 'number') raw = value;
  else if (value && typeof value === 'object') raw = value.points ?? value.Points ?? value.balance ?? null;
  if (raw === null && value?.Data && typeof value.Data === 'object') raw = value.Data.Minutes ?? null;

  return { configured: true, points: Number.isFinite(raw) ? Math.floor(raw) : null };
}

async function getProfileEntry(userId) {
  return getEntry({
    datastoreName: config.roblox.profileDatastore,
    scope: config.roblox.profileScope,
    entryKey: String(userId),
  });
}

/** Reads ProfileStore's Data.PointLog entries for an offline player. */
export async function fetchPointLog(userId) {
  const value = await getProfileEntry(userId);
  if (value === null) return { found: false, entries: [] };

  const rawEntries = value?.Data?.PointLog;
  if (!Array.isArray(rawEntries)) {
    return { found: true, malformed: true, entries: [] };
  }

  const entries = rawEntries.map((entry, index) => {
    if (
      !entry || typeof entry !== 'object' ||
      !Number.isFinite(entry.t) || !Number.isFinite(entry.a) ||
      !Number.isFinite(entry.b) || typeof entry.r !== 'string'
    ) {
      return { kind: 'bad', index };
    }
    return { kind: 'ok', time: entry.t, amount: entry.a, balance: entry.b, reason: entry.r };
  });

  return { found: true, malformed: false, entries };
}