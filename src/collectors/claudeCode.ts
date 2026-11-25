import { isSafeSessionId } from '../sessionId';
import type { UsageRecord } from '../types';
import { isCount, isObject } from '../validation';
import { FileState, num, projectName, safeModel, timestampMs, utcDay } from './lines';

const TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'cache_creation'];

export function parseClaudeLine(line: string, state: FileState): UsageRecord | undefined {
  if (!line.includes('"usage"')) return undefined;
  let entry;
  try { entry = JSON.parse(line); } catch { throw new Error('Malformed Claude usage line'); }
  const message = entry?.message;
  const usage = message?.usage;
  if (entry?.type !== 'assistant' || usage == null || (typeof message.model === 'string' && message.model.startsWith('<'))) return undefined;
  if (isObject(usage) && TOKEN_FIELDS.every(key => usage[key] == null)) return undefined;
  const id = [message.id, entry.requestId, entry.uuid].find(isSafeSessionId);
  const day = utcDay(entry.timestamp);
  if (!id || !day || !isObject(usage) || (!isCount(usage.input_tokens) && !isCount(usage.output_tokens))) throw new Error('Claude usage has no valid identity, timestamp or token counts');
  for (const value of [usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens]) {
    if (value != null && !isCount(value)) throw new Error('Invalid Claude token count');
  }

  const session = isSafeSessionId(entry.sessionId) ? entry.sessionId : undefined;
  state.source = 'claude';
  if (session) state.session = session;
  const split = usage.cache_creation;
  if (split != null && (!isObject(split) || [split.ephemeral_1h_input_tokens, split.ephemeral_5m_input_tokens].some(value => value != null && !isCount(value)))) throw new Error('Invalid Claude cache creation count');
  const cacheWrite1h = isObject(split) ? num(split.ephemeral_1h_input_tokens) : 0;
  const cacheWrite = isObject(split) && isCount(split.ephemeral_5m_input_tokens)
    ? split.ephemeral_5m_input_tokens
    : Math.max(0, num(usage.cache_creation_input_tokens) - cacheWrite1h);
  return {
    id: `claude:${id}`,
    source: 'claude',
    day,
    model: safeModel(message.model),
    tokens: {
      input: num(usage.input_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite,
      cacheWrite1h,
      output: num(usage.output_tokens),
    },
    session,
    project: projectName(entry.cwd),
    ts: timestampMs(entry.timestamp),
  };
}
