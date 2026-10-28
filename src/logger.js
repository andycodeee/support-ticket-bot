import { config } from './config.js';

// Any occurrence of these values is replaced before anything is printed.
const secrets = [config.apiSecret, config.discord.token].filter(Boolean);

export function redact(value) {
  let text;
  if (value instanceof Error) text = value.message;
  else if (typeof value === 'string') text = value;
  else text = JSON.stringify(value) ?? String(value);
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  return text;
}

function write(level, message, extra) {
  const parts = [new Date().toISOString(), level.padEnd(5), redact(message)];
  if (extra !== undefined) parts.push(redact(extra));
  const out = level === 'ERROR' || level === 'WARN' ? console.error : console.log;
  out(parts.join(' '));
}

export const log = {
  info: (message, extra) => write('INFO', message, extra),
  warn: (message, extra) => write('WARN', message, extra),
  error: (message, extra) => write('ERROR', message, extra),
};
