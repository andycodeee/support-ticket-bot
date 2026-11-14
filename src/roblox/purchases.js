import { getEntry, OpenCloudError } from './openCloud.js';

export const PURCHASE_DATASTORE = 'PurchaseData';
const SCOPE = 'global';
const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;

const isNonNegativeNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export function parseRecord(raw) {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'record is not an object' };

  const assetId = typeof raw.assetId === 'number' || typeof raw.assetId === 'string' ? String(raw.assetId) : '';
  if (!/^\d+$/.test(assetId)) return { ok: false, reason: 'missing or invalid assetId' };
  if (!isNonNegativeNumber(raw.cost)) return { ok: false, reason: 'missing or invalid cost' };
  if (typeof raw.status !== 'string') return { ok: false, reason: 'missing status' };
  if (!isNonNegativeNumber(raw.time)) return { ok: false, reason: 'missing or invalid time' };
  if (raw.refunded !== undefined && typeof raw.refunded !== 'boolean') {
    return { ok: false, reason: 'refunded must be true or false' };
  }
  if (raw.source !== undefined && typeof raw.source !== 'string') return { ok: false, reason: 'invalid source' };

  return {
    ok: true,
    record: {
      assetId,
      assetName: typeof raw.assetName === 'string' ? raw.assetName.trim() : '',
      cost: raw.cost,
      status: raw.status,
      refunded: raw.refunded === true,
      source: raw.source || null,
      time: raw.time,
    },
  };
}

/** Resolves a username via the username index, or a numeric UserId directly. */
export async function resolveUserId(input) {
  const raw = input.trim().replace(/^@/, '');
  if (!USERNAME_PATTERN.test(raw)) return { ok: false, reason: 'invalid' };

  const index = await getEntry({
    datastoreName: PURCHASE_DATASTORE,
    scope: SCOPE,
    entryKey: `user_${raw.toLowerCase()}`,
  });

  if (index !== null) {
    if (Number.isSafeInteger(index) && index > 0) {
      return { ok: true, userId: index, label: raw, byUserId: false };
    }
    throw new OpenCloudError('malformed', 'Username index entry is malformed');
  }

  const numeric = Number(raw);
  if (/^\d+$/.test(raw) && Number.isSafeInteger(numeric) && numeric > 0) {
    return { ok: true, userId: numeric, label: raw, byUserId: true };
  }
  return { ok: false, reason: 'not_found' };
}

/** Returns every record in stored order (oldest first). Malformed records are kept, not dropped. */
export async function fetchPurchaseHistory(userId) {
  const value = await getEntry({
    datastoreName: PURCHASE_DATASTORE,
    scope: SCOPE,
    entryKey: String(userId),
  });

  if (value === null) return { found: false, entries: [] };
  if (typeof value !== 'object' || value === null || !Array.isArray(value.records)) {
    throw new OpenCloudError('malformed', 'Purchase entry has an unexpected structure');
  }

  const entries = value.records.map((raw, index) => {
    const parsed = parseRecord(raw);
    return parsed.ok
      ? { kind: 'ok', ...parsed.record }
      : { kind: 'bad', index, reason: parsed.reason };
  });

  return { found: true, entries };
}
