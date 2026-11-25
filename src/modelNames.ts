/**
 * Tools spell a model their own way. Cursor writes `claude-4.6-opus-max-thinking` for Claude Opus 4.6 at maximum effort with thinking on
 * and `gpt-5.5-extra-high` for GPT-5.5 at extra high effort. The effort and the thinking switch change how many tokens a request uses,
 * not what a token of the model costs, so they are taken off and a model keeps one name wherever it runs. `-fast` stays: it is priced
 * apart. Each maker has its own marks, and only those come off its models: `-max` ends the name of `gpt-5.1-codex-max`, a model of its
 * own, and `-thinking` that of `kimi-k2-thinking`.
 */
const marks = (effort: string, thinking: boolean): RegExp => new RegExp(`(?:-(?:${effort})${thinking ? '|-thinking' : ''})+(?=-fast$|$)`);
const MARKS: [RegExp, RegExp][] = [
  [/^claude-/, marks('max|xhigh|high|medium|low', true)],
  [/^(?:gpt-|o\d)/, marks('extra-high|xhigh|high|medium|low|minimal', false)],
  [/^gemini-/, marks('xhigh|high|medium|low|minimal', false)],
];

/** Anthropic puts the family first (`claude-opus-4-6`), Cursor the version (`claude-4.6-opus`). The Claude 3 models keep the version first. */
const VERSION_FIRST = /^claude-([4-9])(?:[.-](\d+))?-(opus|sonnet|haiku)$/;

/** What Cursor calls its own modes: Auto picks the model itself, and the review agent has a name of its own. */
const CURSOR_MODES = new Map([['default', 'cursor-auto'], ['agent_review', 'cursor-agent-review']]);

/** The name the page and the price tables know a model by. Names that need no change come back as they were. */
export function canonicalModel(model: string): string {
  const mode = CURSOR_MODES.get(model);
  if (mode) return mode;
  const lower = model.toLowerCase();
  if (lower === 'gemini-4-hydrogen-tiered-high') return lower;
  const marked = MARKS.find(([maker]) => maker.test(lower))?.[1];
  const plain = (marked ? lower.replace(marked, '') : lower).replace(VERSION_FIRST, (_, major: string, minor: string | undefined, family: string) => `claude-${family}-${major}${minor ? `-${minor}` : ''}`);
  return plain === lower ? model : plain;
}
