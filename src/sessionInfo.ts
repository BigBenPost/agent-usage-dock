import { promises as fs } from 'fs';
import * as path from 'path';
import { ANTIGRAVITY_BRAIN_ROOT, claudeHome, claudeProjects, codexHome, codexLogRoots } from './paths';
import { isSafeSessionId } from './sessionId';
import { readDsh } from './collectors/dsh';
import { FileState, listJsonl } from './collectors/lines';
import { Source } from './types';

/**
 * What a conversation was about.
 */
export interface SessionInfo {
  file: string;
  folder?: boolean;
  title?: string;
  firstPrompt?: string;
  cwd?: string;
  branch?: string;
}

const HEAD_BYTES = 4 * 1024 * 1024;
const TAIL_BYTES = 1024 * 1024;
const PROMPT_CHARS = 600;

/** A file the scanner already knows about that sits under one of `roots` and has a matching name, if it still exists. */
async function knownFile(known: Record<string, FileState> | undefined, roots: string[], matches: (name: string) => boolean): Promise<string | undefined> {
  for (const file of Object.keys(known ?? {})) {
    if (!matches(path.basename(file)) || !roots.some(root => file.startsWith(root + path.sep))) continue;
    try {
      if ((await fs.stat(file)).isFile()) return file;
    } catch {
      // moved or deleted since the last scan; the folder walk looks again
    }
  }
  return undefined;
}

/**
 * Finds the log file of a session, or undefined when it has been deleted. Paths the scanner recorded in `known` are tried
 * first; the log folders are walked only when none of them is still there.
 */
export async function findSessionLog(source: Source, id: string, antigravityBrain = ANTIGRAVITY_BRAIN_ROOT, homes: { claudeHome?: string; codexHome?: string } = {}, known?: Record<string, FileState>, list: (root: string) => Promise<string[]> = listJsonl): Promise<string | undefined> {
  if (!isSafeSessionId(id)) return undefined;
  if (source === 'claude') {
    const root = claudeProjects(claudeHome(homes.claudeHome));
    const name = `${id}.jsonl`;
    return await knownFile(known, [root], base => base === name) ?? (await list(root)).find(file => path.basename(file) === name);
  }
  if (source === 'codex') {
    const roots = codexLogRoots(codexHome(homes.codexHome));
    const suffix = `-${id}.jsonl`;
    const recorded = await knownFile(known, roots, base => base.endsWith(suffix));
    if (recorded) return recorded;
    for (const root of roots) {
      const found = (await list(root)).find(file => path.basename(file).endsWith(suffix));
      if (found) return found;
    }
    return undefined;
  }
  if (source !== 'antigravity') return undefined;
  const recorded = Object.entries(known ?? {}).find(([file, state]) => state.session === id && file.startsWith(antigravityBrain + path.sep) && file.endsWith('transcript.jsonl'))?.[0];
  const file = recorded ?? path.join(antigravityBrain, id, '.system_generated', 'logs', 'transcript.jsonl');
  try {
    if ((await fs.stat(file)).isFile()) return file;
  } catch {
    // not found
  }
  return undefined;
}

/** Complete lines from the start and the end of a file; a huge log is not read in full. */
async function readEnds(file: string): Promise<{ head: string[]; tail: string[] }> {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const read = async (pos: number, len: number): Promise<string> => {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      return buf.toString('utf8', 0, bytesRead);
    };
    if (size <= HEAD_BYTES + TAIL_BYTES) {
      const lines = (await read(0, size)).split('\n');
      return { head: lines, tail: [] };
    }
    const head = (await read(0, HEAD_BYTES)).split('\n');
    head.pop(); // cut mid-line
    const tail = (await read(size - TAIL_BYTES, TAIL_BYTES)).split('\n');
    tail.shift(); // starts mid-line
    return { head, tail };
  } finally {
    await fh.close();
  }
}

const clip = (s: string): string => {
  const t = s.trim();
  return t.length > PROMPT_CHARS ? `${t.slice(0, PROMPT_CHARS).trimEnd()}…` : t;
};

function parse(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function promptText(content: unknown): string | undefined {
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.find(b => typeof b?.text === 'string')?.text : undefined;
  const prompt = typeof text === 'string' ? text.trim() : '';
  return prompt && !prompt.startsWith('<') ? prompt : undefined;
}

function codexPrompt(content: unknown): string | undefined {
  const prompt = promptText(content);
  if (!prompt || prompt.startsWith('# AGENTS.md')) return undefined;
  if (!prompt.startsWith('# Context')) return prompt;
  return /##\s*My request[^\n]*:\s*\n([\s\S]*)/.exec(prompt)?.[1].trim() || undefined;
}

export async function readSessionInfo(source: Source, file: string): Promise<SessionInfo> {
  if (source === 'dsh') {
    const result = await readDsh(file, (await fs.stat(file)).mtimeMs, undefined, true);
    return { file: path.dirname(file), folder: true, title: result.title, firstPrompt: result.firstPrompt };
  }
  const { head, tail } = await readEnds(file);
  const info: SessionInfo = { file };
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  for (const line of head) {
    if (!line) continue;
    const entry = parse(line);
    if (!entry) continue;
    if (source === 'claude') {
      info.cwd ??= typeof entry.cwd === 'string' ? entry.cwd : undefined;
      info.branch ??= typeof entry.gitBranch === 'string' && entry.gitBranch !== 'HEAD' ? entry.gitBranch : undefined;
      if (!info.firstPrompt && entry.type === 'user' && !entry.isMeta && !entry.isSidechain) {
        const prompt = promptText(entry.message?.content);
        if (prompt) info.firstPrompt = clip(prompt);
      }
      if (typeof entry.customTitle === 'string' && entry.customTitle.trim()) customTitle = clip(entry.customTitle);
      if (typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) aiTitle = clip(entry.aiTitle);
    } else if (source === 'codex') {
      const p = entry.payload;
      if (entry.type === 'session_meta' || entry.type === 'turn_context') {
        info.cwd ??= typeof p?.cwd === 'string' ? p.cwd : undefined;
        info.branch ??= typeof p?.git?.branch === 'string' ? p.git.branch : undefined;
      } else if (!info.firstPrompt && p) {
        const content = entry.type === 'response_item' && p.type === 'message' && p.role === 'user' ? p.content
          : entry.type === 'event_msg' && p.type === 'user_message' ? p.message : undefined;
        const prompt = codexPrompt(content);
        if (prompt) info.firstPrompt = clip(prompt);
      }
    } else if (!info.firstPrompt && (entry.type === 'USER_INPUT' || entry.role === 'user')) {
      const text = typeof entry.content === 'string' ? entry.content : typeof entry.prompt === 'string' ? entry.prompt : undefined;
      if (text && text.trim() && !text.trim().startsWith('<')) {
        info.firstPrompt = clip(text);
      }
    }
  }
  if (source === 'claude') {
    for (const line of tail) {
      if (!line.includes('"aiTitle"') && !line.includes('"customTitle"')) continue;
      const entry = parse(line);
      if (typeof entry?.customTitle === 'string' && entry.customTitle.trim()) customTitle = clip(entry.customTitle);
      if (typeof entry?.aiTitle === 'string' && entry.aiTitle.trim()) aiTitle = clip(entry.aiTitle);
    }
    info.title = customTitle ?? aiTitle;
  }
  return info;
}
