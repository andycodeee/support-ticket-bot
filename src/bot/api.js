import { config } from '../config.js';
import { log } from '../logger.js';

export class ApiError extends Error {
  constructor(status, body, retryable) {
    super(`API responded ${status}${body?.error ? ` (${body.error})` : ''}`);
    this.status = status;
    this.body = body;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(method, path, { body, retries = 4 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${config.apiBaseUrl}${path}`, {
        method,
        headers: {
          'X-API-Secret': config.apiSecret,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = {};
      }
      if (res.ok) return data;
      throw new ApiError(res.status, data, res.status >= 500 || res.status === 429);
    } catch (err) {
      // Network errors and 5xx/429 are retried; other 4xx are final.
      const retryable = err instanceof ApiError ? err.retryable : true;
      if (!retryable || attempt >= retries) throw err;
      const delay = Math.min(15_000, 1000 * 2 ** (attempt - 1));
      log.warn(`API ${method} ${path} failed (attempt ${attempt}), retrying in ${delay}ms`, err);
      await sleep(delay);
    }
  }
}

export async function fetchTicketsAfter(afterId, limit = 50) {
  const data = await request('GET', `/support/tickets?afterId=${afterId}&limit=${limit}`);
  return data.tickets ?? [];
}

export function submitResponse(payload) {
  return request('POST', '/support/responses', { body: payload });
}
