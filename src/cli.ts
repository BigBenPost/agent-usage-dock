import { migrateLegacyStore, sharedStoreFile } from './paths';
import { refreshUsage } from './scan';
import { UsageStore } from './store';
import { SCANNED_SOURCES, ScannedSource, SOURCE_LABELS } from './types';

const USAGE = `agent-usage-dock CLI
  node cli.js flush [--source ${SCANNED_SOURCES.join('|')}|all]
                    [--home PATH] [--dsh-home PATH] [--claude-home PATH] [--codex-home PATH]
                                      read selected local logs (default: antigravity)
  node cli.js import <file>          import and merge another usage store, or the usage ledger of the
                                     cursor-usage-monitor extension, into the shared store
  node cli.js help | --help | -h     print this text`;

async function main(): Promise<number> {
  const cmd = process.argv[2];
  if (cmd === 'import') {
    const file = process.argv[3];
    if (!file || process.argv.length > 4) {
      console.error(USAGE);
      return 2;
    }
    await migrateLegacyStore();
    const store = await UsageStore.load(sharedStoreFile());
    const beforeRecords = Object.keys(store.data.records ?? {}).length;
    const ok = await store.absorb(file);
    if (!ok) {
      console.error(`ERROR: file not found: ${file}`);
      return 1;
    }
    const afterRecords = Object.keys(store.data.records ?? {}).length;
    const added = afterRecords - beforeRecords;
    console.log(`Imported ${file} into ${sharedStoreFile()}: ${added} new records added (total ${afterRecords} records across ${Object.keys(store.data.days).length} days, ${Object.keys(store.data.sessions ?? {}).length} sessions).`);
    return 0;
  }
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    return 0;
  }
  if (cmd !== 'flush') {
    console.error(USAGE);
    return 2;
  }
  const args = process.argv.slice(3);
  let source: ScannedSource | 'all' = 'antigravity';
  const homes: Partial<Record<string, string>> = {};
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!['--home', '--source', '--dsh-home', '--claude-home', '--codex-home'].includes(flag) || !value || value.startsWith('--') || seen.has(flag)) { console.error(USAGE); return 2; }
    seen.add(flag);
    if (flag === '--source') {
      const selected = value === 'all' ? value : SCANNED_SOURCES.find(s => s === value);
      if (!selected) { console.error(USAGE); return 2; }
      source = selected;
    } else {
      homes[flag] = value;
    }
  }
  await migrateLegacyStore();
  const store = await UsageStore.load(sharedStoreFile());
  const { changed, files, problems, sources } = await refreshUsage(store, sharedStoreFile(), homes['--home'], false, {
    source, strict: true, dshHome: homes['--dsh-home'], claudeHome: homes['--claude-home'], codexHome: homes['--codex-home'],
  });
  console.log(`Usage store ${sharedStoreFile()}: ${changed} records added or updated from ${files} changed files.`);
  const labels = { ok: 'Ready', incomplete: 'Incomplete', 'not-found': 'Not installed', disabled: 'Disabled' };
  for (const { source: name, status } of sources) console.log(`${SOURCE_LABELS[name]}: ${labels[status]}`);
  // Deleting logs after a flush that skipped some would lose their usage for good, so say it and fail.
  for (const problem of problems) console.error(`ERROR: ${problem}`);
  if (problems.length) console.error('ERROR: some logs could not be read, so their usage is not in the store yet.');
  return problems.length ? 1 : 0;
}

/** Output is flushed by letting the process end on its own; the timer only stops a stray handle from keeping it alive. */
function finish(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(), 2000).unref();
}

main().then(finish, (err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  finish(1);
});
