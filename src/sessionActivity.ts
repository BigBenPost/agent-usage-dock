import * as path from 'path';
import type { FileState } from './collectors/lines';
import { ACTIVE_WINDOW_MS } from './types';

export { ACTIVE_WINDOW_MS };

export function activeSessionKeys(files: Record<string, FileState>, now = Date.now()): Set<string> {
  const keys = new Set<string>();
  for (const [file, state] of Object.entries(files)) {
    if (now - state.mtimeMs > ACTIVE_WINDOW_MS) continue;
    if (state.source && state.session) keys.add(`${state.source}:${state.session}`);
    if (file.endsWith('session.v4.jsonl.zstd') && state.session) keys.add('dsh:' + state.session);
    if (file.endsWith('.db')) keys.add(`antigravity:${state.session ?? path.basename(file, '.db')}`);
    if (file.includes('transcript.jsonl')) {
      const parts = file.split(path.sep);
      const cidIdx = parts.lastIndexOf('.system_generated') - 1;
      const cid = cidIdx >= 0 ? parts[cidIdx] : undefined;
      if (state.session ?? cid) keys.add(`antigravity:${state.session ?? cid}`);
    }
  }
  return keys;
}
