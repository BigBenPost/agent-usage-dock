const SERIES = ['dot', 'swatch', 'seg', 'key'];
const paint = (name: string, colour: string): string => `${SERIES.map((kind) => `.${kind}.${name}`).join(', ')}, .hbar i.${name} { background: ${colour}; }`;
const SHADE_MIXES = ['65%, #fff', '70%, #000', '40%, #fff'];
const shades = (name: string): string =>
  SHADE_MIXES.map((mix, i) => `.swatch.${name}.s${i + 1}, .seg.${name}.s${i + 1}, .key.${name}.s${i + 1} { background: color-mix(in srgb, var(--${name}) ${mix}); }`).join('\n  ');
const slices = (name: string): string =>
  [`.slice.${name} { fill: var(--${name}); }`, ...SHADE_MIXES.map((mix, i) => `.slice.${name}.s${i + 1} { fill: color-mix(in srgb, var(--${name}) ${mix}); }`)].join('\n  ');
const FAMILIES = ['gemini', 'opus', 'gpt', 'deepseek', 'composer', 'unknown'];
const SOURCES = ['antigravity', 'dsh', 'claude', 'codex', 'cursor'];

export const STYLE = `
  *, *::before, *::after { box-sizing: border-box; }
  [hidden] { display: none !important; }
  /* Light is "Mist": a blue-grey page with a faint aurora under frosted cards. Dark is "Noir": the same glass over a near-black page. */
  body {
    --page: #eceff3; --card: rgba(255, 255, 255, 0.5); --sheet: rgba(246, 247, 250, 0.94); --menu: #f8f9fb; --inset: rgba(255, 255, 255, 0.5);
    --edge: rgba(255, 255, 255, 0.75); --hair: rgba(20, 24, 32, 0.07); --hair-2: rgba(20, 24, 32, 0.15);
    --ink: #141820; --ink-2: #565d6b; --muted: #5d6573;
    --gemini: #8e44ad; --opus: #d4683a; --gpt: #7f79a1; --deepseek: #4d6bfe; --composer: #2f8f83; --unknown: #8c8981; --positive: #1b7340;
    --antigravity: var(--gemini); --dsh: var(--deepseek); --claude: var(--opus); --codex: var(--gpt); --cursor: var(--composer); --accent: #141820;
    --meter-grad: none; --meter-glow: none; --seg-sheen: none;
    --track: rgba(20, 24, 32, 0.07); --track-warn: #f6e7c4; --track-crit: #f3d6d6;
    --warning: #e0a019; --critical: #d03b3b; --warn-ink: #8a5a00; --banner: rgba(255, 240, 205, 0.75);
    --row-hover: rgba(255, 255, 255, 0.55); --row-sel: rgba(255, 255, 255, 0.8); --pace: #565d6b; --pace-line: 1px dashed var(--pace); --pace-glow: none;
    --tip-bg: rgba(20, 24, 32, 0.9); --tip-ink: #f4f6fa; --tip-mute: #a9b0bd;
    --shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 16px 40px -28px rgba(20, 24, 32, 0.25);
    --aurora: radial-gradient(720px 420px at 8% 0, rgba(255, 201, 179, 0.55), transparent 70%), radial-gradient(640px 400px at 92% 60px, rgba(181, 198, 255, 0.6), transparent 70%),
      radial-gradient(560px 460px at 0 42%, rgba(205, 224, 240, 0.5), transparent 70%), radial-gradient(600px 460px at 100% 70%, rgba(255, 214, 196, 0.4), transparent 70%),
      radial-gradient(700px 380px at 55% 100%, rgba(196, 204, 255, 0.5), transparent 70%);
    margin: 0; padding: 0; min-height: 100vh; background: var(--aurora), var(--page); color: var(--ink);
    font-family: var(--vscode-font-family, -apple-system, "Segoe UI", sans-serif); font-size: 13px; line-height: 1.45; -webkit-font-smoothing: antialiased;
  }
  body.theme-dark, body.theme-auto:not(.vscode-light):not(.vscode-high-contrast-light) {
    --page: #09090b; --card: rgba(255, 255, 255, 0.035); --sheet: rgba(18, 18, 22, 0.92); --menu: #17171d; --inset: rgba(255, 255, 255, 0.03);
    --edge: rgba(255, 255, 255, 0.08); --hair: rgba(255, 255, 255, 0.08); --hair-2: rgba(255, 255, 255, 0.16);
    --ink: #f4f2ff; --ink-2: #a9a6b8; --muted: #a19db1;
    --gemini: #c49bff; --opus: #ff8a5c; --gpt: #b0a9c9; --deepseek: #6580ff; --composer: #5cc6b6; --unknown: #8c8981; --positive: #6ee7b7;
    --antigravity: var(--gemini); --dsh: var(--deepseek); --claude: var(--opus); --codex: var(--gpt); --cursor: var(--composer); --accent: #c4b5ff;
    --meter-grad: linear-gradient(90deg, #7c9cff, #c49bff); --meter-glow: 0 0 10px rgba(196, 155, 255, 0.55); --seg-sheen: linear-gradient(180deg, rgba(255, 255, 255, 0.25), rgba(255, 255, 255, 0) 70%);
    --track: rgba(255, 255, 255, 0.08); --track-warn: #3a2f10; --track-crit: #3d1f1f;
    --warning: #ffc069; --critical: #ff6b7a; --warn-ink: #ffc069; --banner: rgba(255, 192, 105, 0.12);
    --row-hover: rgba(255, 255, 255, 0.04); --row-sel: rgba(196, 181, 255, 0.08); --pace: #c49bff; --pace-line: 1px solid var(--pace); --pace-glow: 0 0 8px #c49bff;
    --tip-bg: rgba(20, 20, 26, 0.88); --tip-ink: #f4f2ff; --tip-mute: #a9a6b8;
    --shadow: inset 0 1px 0 rgba(255, 255, 255, 0.07), 0 30px 60px -30px #000;
    --aurora: radial-gradient(720px 420px at 8% 0, rgba(255, 138, 92, 0.18), transparent 70%), radial-gradient(640px 400px at 92% 60px, rgba(124, 156, 255, 0.17), transparent 70%),
      radial-gradient(560px 460px at 0 42%, rgba(183, 148, 255, 0.11), transparent 70%), radial-gradient(600px 460px at 100% 70%, rgba(255, 138, 92, 0.09), transparent 70%),
      radial-gradient(700px 380px at 55% 100%, rgba(124, 156, 255, 0.12), transparent 70%);
  }
  .page { max-width: 1600px; margin: 0 auto; padding: 28px 28px 56px; }
  h1, h2, h3 { margin: 0; letter-spacing: -0.02em; }
  h1 { font-size: 22px; font-weight: 500; display: flex; align-items: center; gap: 8px; }
  .brand { height: 1.3em; width: 1.3em; vertical-align: middle; flex-shrink: 0; }
  h1 .usage { font-size: 20px; font-weight: 500; color: var(--ink); }
  small, .sub { color: var(--muted); font-size: 12px; }
  .warn { color: var(--warn-ink); }
  .eyebrow { margin: 0; font-size: 10px; font-weight: 500; letter-spacing: 0.22em; text-transform: uppercase; color: var(--ink-2); display: flex; align-items: center; gap: 6px; }
  button, select { font: inherit; color: inherit; }
  code { color: inherit; background: var(--track); border-radius: 4px; padding: 1px 4px; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }

  .top { display: flex; justify-content: space-between; align-items: flex-end; flex-wrap: wrap; gap: 6px 24px; margin-bottom: 20px; }
  .meta { display: flex; flex-direction: column; gap: 2px; }
  .meta a { color: var(--ink-2); text-decoration: underline; text-decoration-color: var(--hair-2); text-underline-offset: 3px; }
  .meta a:hover { text-decoration: underline; }
  .meta .linkbtn { align-self: flex-start; margin-top: 6px; font-weight: 500; }
  @media (min-width: 700px) { .meta { text-align: right; } .meta .linkbtn { align-self: flex-end; } }
  .zonebar { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
  .segmented.small button { padding: 2px 10px; font-size: 11px; }
  .monthnav { display: flex; align-items: center; gap: 6px; margin: 8px 0 4px; }
  .monthnav .icon-btn { width: 27px; height: 27px; font-size: 16px; }
  .monthnav .icon-btn:disabled { opacity: 0.35; cursor: default; }
  .monthnav .icon-btn:disabled:hover { background: transparent; color: var(--ink-2); }
  .monthnav .linkbtn { margin: 0 0 0 6px; }
  .banner { margin: 0 0 16px; padding: 10px 14px; border-radius: 10px; background: var(--banner); }
  .card { background: var(--card); border: 1px solid var(--edge); border-radius: 22px; box-shadow: var(--shadow); padding: 24px 28px; margin: 0 0 18px; backdrop-filter: blur(24px) saturate(1.3); -webkit-backdrop-filter: blur(24px) saturate(1.3); }
  .card-head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px 16px; margin-bottom: 14px; }
  .card-meta { margin-left: auto; color: var(--muted); font-size: 11px; letter-spacing: 0; font-variant-numeric: tabular-nums; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex: none; }
  ${[...FAMILIES.map((name) => paint(name, `var(--${name})`)), ...SOURCES.map((name) => paint(name, `var(--${name})`))].join('\n  ')}
  ${FAMILIES.map(shades).join('\n  ')}
  ${FAMILIES.map(slices).join('\n  ')}
  .slice.rest { fill: var(--muted); }
  .swatch.rest { background: var(--muted); }

  .pair { display: grid; gap: 16px; margin-bottom: 16px; }
  .pair > .card { margin: 0; min-width: 0; }
  @media (min-width: 1000px) { .pair { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }
  .hero-figure { display: flex; align-items: flex-start; font-size: 76px; font-weight: 200; letter-spacing: -0.055em; line-height: 1; margin: 12px 0 24px; font-variant-numeric: tabular-nums; }
  .hero-figure .cents { font-size: 0.4em; letter-spacing: 0; color: var(--muted); margin: 0.14em 0 0 0.04em; }
  .hero { display: flex; flex-direction: column; justify-content: space-between; }
  .hero .card-head { margin-bottom: 0; }
  .hero .bar-head { flex-wrap: wrap; gap: 4px 10px; font-size: 11px; }
  .stat.hero-today b { font-weight: inherit; font-size: inherit; }
  body.theme-dark .hero-figure .int, body.theme-auto:not(.vscode-light):not(.vscode-high-contrast-light) .hero-figure .int { background: linear-gradient(180deg, var(--ink) 30%, rgba(244, 242, 255, 0.55)); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .meter { position: relative; height: 3px; border-radius: 2px; background: var(--track); }
  .meter .fill { height: 100%; border-radius: 2px; background: var(--accent); background-image: var(--meter-grad); box-shadow: var(--meter-glow); }
  .meter.warning { background: var(--track-warn); }
  .meter.warning .fill { background: var(--warning); box-shadow: none; }
  .meter.critical { background: var(--track-crit); }
  .meter.critical .fill { background: var(--critical); box-shadow: none; }
  .meter .tick { position: absolute; top: -4px; bottom: -4px; width: 0; border-left: 1px solid var(--hair-2); }
  .bar-block + .bar-block { margin-top: 14px; }
  .bar-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 8px; color: var(--muted); font-size: 12px; }
  .bar-head b { color: var(--ink); font-weight: 600; margin-left: 6px; }
  .status { display: inline-flex; align-items: center; gap: 6px; margin: 10px 0 14px; font-weight: 600; font-size: 12px; }
  .status.warning svg { color: var(--warning); }
  .status.critical svg { color: var(--critical); }
  .stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 22px; margin-top: auto; padding-top: 18px; border-top: 1px solid var(--hair); }
  @media (min-width: 540px) { .stats { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  @media (max-width: 539px) { .stat:last-child:nth-child(odd) { grid-column: 1 / -1; } }
  .stat { min-width: 0; }
  .stat dt { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; font-weight: 500; }
  .stat dd { margin: 4px 0 0; font-size: 20px; font-weight: 300; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; color: var(--ink); }
  .stat dd small { letter-spacing: 0; font-weight: 400; display: block; white-space: nowrap; color: var(--muted); font-size: 12px; margin-top: 2px; }

  .gchart { display: flex; flex-direction: column; }
  .gchart .card-head { align-items: center; margin-bottom: 4px; }
  .gchart .by, .gchart .metric { display: contents; }
  .gchart[data-pie="cost"] .metric-tokens, .gchart[data-pie="tokens"] .metric-cost { display: none; }
  .gchart[data-group="model"] .by-tool, .gchart[data-group="tool"] .by-model { display: none; }
  .chart-foot { margin-top: 14px; padding-top: 0; }
  .legend { display: flex; flex-wrap: wrap; gap: 8px 20px; font-size: 12px; color: var(--ink-2); }
  .legend-item { display: inline-flex; align-items: center; gap: 7px; max-width: 100%; }
  .legend-item .name { max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .legend-item small { color: var(--muted); font-variant-numeric: tabular-nums; }
  .legend-item.more { color: var(--muted); cursor: default; }
  .legend-item .dash { width: 16px; flex: none; border-top: var(--pace-line); box-shadow: var(--pace-glow); }
  .swatch { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .pace { position: absolute; left: 0; right: 0; height: 0; border-top: var(--pace-line); box-shadow: var(--pace-glow); opacity: 0.75; pointer-events: none; z-index: 2; }
  .chart {
    flex: 1 1 auto;
    min-height: 140px;
    display: grid;
    grid-template-columns: 48px minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
    column-gap: 8px;
    padding-top: 16px;
  }
  .yaxis { position: relative; height: 100%; min-height: 120px; }
  .yaxis span { position: absolute; right: 0; transform: translateY(50%); font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .plot { position: relative; height: 100%; min-height: 120px; }
  .grid { position: absolute; left: 0; right: 0; height: 0; border-top: 1px dashed var(--hair); }
  .grid:first-child { border-color: var(--hair-2); }
  .cols { position: absolute; inset: 0; display: grid; grid-template-columns: repeat(var(--cols), minmax(0, 1fr)); grid-template-rows: minmax(0, 1fr); }
  .col { position: relative; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; min-height: 0; height: 100%; border-radius: 8px; outline: none; }
  .col:hover, .col:focus-visible { background: var(--row-hover); }
  .col:focus-visible { outline: 2px solid var(--accent); }
  .stack { position: relative; width: min(46%, 12px); flex: none; display: flex; flex-direction: column-reverse; }
  .stack > .by { display: flex; flex-direction: column-reverse; height: 100%; min-height: 0; }
  .seg { display: block; width: 100%; min-height: 0; border-radius: 1.5px; }
  .seg:last-of-type { border-radius: 4px 4px 1.5px 1.5px; }
  .stack .seg { background-image: var(--seg-sheen); }
  .peak { position: absolute; bottom: calc(100% + 4px); left: 50%; transform: translateX(-50%); font-size: 11px; font-weight: 500; color: var(--ink-2); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .xaxis { grid-column: 2; display: grid; grid-template-columns: repeat(var(--cols), minmax(0, 1fr)); margin-top: 8px; text-align: center; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .xaxis .today { color: var(--ink); font-weight: 600; }
  .tip { display: none; position: absolute; top: 4px; left: calc(100% + 6px); z-index: 5; min-width: 156px; width: max-content; max-width: min(420px, 80vw); max-height: min(340px, 70vh); overflow-y: auto; padding: 10px 12px; border-radius: 10px; pointer-events: none; font-size: 12px;
    background: var(--tip-bg); color: var(--tip-ink); border: 1px solid rgba(255, 255, 255, 0.08); box-shadow: 0 12px 32px -12px rgba(0, 0, 0, 0.45); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); }
  .tip.left-of { left: auto; right: calc(100% + 6px); }
  .tip.center { left: 50%; right: auto; transform: translateX(-50%); }
  .col:hover .tip, .col:focus-visible .tip { display: block; }
  .tip-h { color: var(--tip-mute); margin-bottom: 6px; }
  .tip-r { display: flex; align-items: center; gap: 8px; padding: 1px 0; }
  .tip-r b { min-width: 52px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .tip-r span { color: var(--tip-mute); min-width: 0; overflow-wrap: anywhere; }
  .tip-r.total { margin-top: 5px; padding-top: 5px; border-top: 1px solid rgba(255, 255, 255, 0.16); }
  .key { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  .key.rest { background: var(--tip-mute); }

  .sortbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .segmented { display: inline-flex; gap: 2px; padding: 2px; border-radius: 999px; background: var(--track); }
  .segmented button { border: 0; background: transparent; color: var(--ink-2); padding: 3px 13px; border-radius: 999px; font-size: 12px; cursor: pointer; transition: background 0.15s, color 0.15s; }
  .segmented button:hover { color: var(--ink); }
  .segmented button.active { background: var(--ink); color: var(--page); }

  .multi { position: relative; display: inline-block; max-width: 100%; }
  .multi-btn { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; font-size: 12px; background: transparent; border: 1px solid var(--hair-2); border-radius: 999px; padding: 4px 12px; cursor: pointer; transition: background 0.15s; }
  .multi-btn:hover, .multi.open .multi-btn { background: var(--row-hover); }
  .multi-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .caret { width: 5px; height: 5px; flex: none; border-right: 1.5px solid var(--ink-2); border-bottom: 1.5px solid var(--ink-2); transform: translateY(-2px) rotate(45deg); transition: transform 0.15s; }
  .multi.open .caret { transform: translateY(1px) rotate(-135deg); }
  .multi-list { position: absolute; z-index: 6; top: calc(100% + 6px); left: 0; min-width: 100%; width: max-content; max-width: min(320px, 80vw); max-height: min(420px, 70vh); overflow-y: auto; padding: 6px; border-radius: 12px; background: var(--menu); border: 1px solid var(--hair-2); box-shadow: 0 18px 40px -18px rgba(20, 24, 32, 0.45); }
  .multi-item { display: flex; align-items: center; gap: 8px; width: 100%; border: 0; background: transparent; padding: 6px 10px; border-radius: 8px; font-size: 12px; color: var(--ink); text-align: left; white-space: nowrap; cursor: pointer; }
  .multi-item:hover { background: var(--row-hover); }
  .multi-item[aria-pressed="true"] { font-weight: 600; }
  .menu-check { width: 10px; height: 10px; flex: none; position: relative; }
  .multi-item[aria-pressed="true"] .menu-check::after { content: ''; position: absolute; left: 2px; top: 1px; width: 4px; height: 7px; border-right: 1.5px solid var(--accent); border-bottom: 1.5px solid var(--accent); transform: rotate(40deg); }
  .multi-item input { margin: 0; accent-color: var(--accent); }
  .multi-sep { height: 1px; margin: 4px 6px; background: var(--hair); }

  .slist, .mgrid { display: grid; gap: 10px; }
  @media (min-width: 900px) { .slist, .mgrid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .scard, .mcard { background: transparent; border: 1px solid var(--hair); border-radius: 14px; min-width: 0; transition: background 0.12s, border-color 0.12s; }
  .mcard { padding: 14px; background: var(--inset); border-color: transparent; }
  .mcard.model { background: transparent; border-color: var(--hair); }
  .mcard.model:hover { background: var(--row-hover); border-color: var(--hair-2); }
  ${FAMILIES.map((name) => `.f-${name} { --fam: var(--${name}); }`).join(' ')}
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .chip { display: inline-flex; align-items: center; padding: 2px 10px; border-radius: 999px; background: var(--track); color: var(--ink-2); font-size: 11px; line-height: 1.5; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .chip.share { position: relative; padding: 0; overflow: hidden; min-width: 88px; color: var(--ink); }
  .chip.share > span { position: relative; display: block; width: 100%; padding: 2px 10px; text-align: center; }
  .chip.share i { position: absolute; inset: 0 auto 0 0; background: color-mix(in srgb, var(--fam) 38%, transparent); }
  .chip.share .v { position: relative; display: inline; padding: 0; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(76px, 1fr)); gap: 6px; margin-top: 12px; }
  .tile { display: grid; gap: 1px; min-width: 0; padding: 6px 10px 7px; border: 1px solid var(--hair-2); border-radius: 12px; font-variant-numeric: tabular-nums; }
  .tile small { color: var(--muted); font-size: 10px; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase; white-space: nowrap; }
  .tile b { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tile em { color: var(--muted); font-style: normal; font-size: 11px; }
  .tile.off { border-color: var(--hair); }
  .tile.off b { color: var(--muted); font-weight: 400; }
  .rate-foot { display: block; margin-top: 6px; color: var(--muted); font-size: 11px; line-height: 1.35; }
  .rate-foot b { color: var(--ink-2); font-weight: 500; }
  .tiles + .rate-foot { margin-top: 10px; }
  .scard:hover { background: var(--row-hover); border-color: var(--hair-2); }
  .scard.open { background: var(--row-sel); border-color: var(--hair-2); }
  .scard-main { display: block; width: 100%; padding: 14px; background: none; border: 0; text-align: left; cursor: pointer; border-radius: 14px; }
  .srow1 { display: flex; align-items: center; gap: 8px; }
  .srow1 .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .srow1 .cost { font-variant-numeric: tabular-nums; white-space: nowrap; font-weight: 600; font-size: 14px; }
  .mcard .srow1 .name { white-space: normal; overflow-wrap: anywhere; }
  .srow2 { display: block; margin-top: 2px; color: var(--muted); font-size: 12px; }
  .tok5 { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; margin-top: 10px; font-variant-numeric: tabular-nums; }
  .tok5 .t { display: block; min-width: 0; }
  .tok5 b { display: block; font-size: 12px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tok5 small { display: block; font-size: 10px; font-weight: 500; color: var(--muted); text-transform: uppercase; letter-spacing: 0.14em; }
  td .zero, .tok5 .zero { color: var(--hair-2); }
  .hbar { display: block; height: 2px; border-radius: 2px; background: var(--track); overflow: hidden; margin-top: 10px; }
  .hbar i { display: block; height: 100%; border-radius: 2px; }
  .scard.total { margin-top: 10px; padding: 14px; background: var(--inset); border-style: dashed; }
  .inuse { color: var(--warn-ink); font-weight: 600; }
  .session-pages { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-top: 14px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
  .session-pages .linkbtn { margin: 0; padding: 4px 12px; border: 1px solid var(--hair-2); border-radius: 999px; font-weight: 400; text-decoration: none; }
  .session-pages .linkbtn:hover:not(:disabled) { background: var(--row-hover); }
  .session-pages button:disabled { opacity: 0.45; cursor: default; }

  .d-sec { padding: 14px 0; border-top: 1px solid var(--hair); }
  .d-sec .eyebrow { margin-bottom: 8px; }
  .d-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 20px; }
  .d-big { font-size: 30px; font-weight: 200; letter-spacing: -0.03em; line-height: 1.15; }
  .d-mid { font-size: 15px; font-weight: 500; }
  .facts { margin: 0; display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 10px 14px; }
  .facts dt { color: var(--muted); }
  .facts dd { margin: 0; min-width: 0; word-break: break-word; }
  .quote { border-left: 2px solid var(--hair-2); padding-left: 12px; color: var(--ink); white-space: pre-wrap; }
  .mono { font-family: var(--vscode-editor-font-family, ui-monospace, Menlo, Consolas, monospace); font-size: 11.5px; word-break: break-all; }
  .parts { list-style: none; margin: 0; padding: 0; }
  .parts li { display: grid; grid-template-columns: minmax(0, 1fr) auto 64px 40px; gap: 2px 12px; align-items: baseline; padding: 6px 0; }
  .parts .p-tok, .parts .p-share { color: var(--muted); text-align: right; font-variant-numeric: tabular-nums; }
  .parts .p-cost { text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
  .parts .hbar { grid-column: 1 / -1; margin-top: 2px; }
  .d-loading { color: var(--muted); margin: 14px 0 0; }

  /* The session popup: a card centred over a dimmed page. Nothing in the list moves when it opens. */
  #scrim { position: fixed; inset: 0; z-index: 10; background: rgba(9, 9, 11, 0.3); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px); animation: fade 0.15s ease; }
  #popup { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; padding: 16px; }
  .pop-card { width: min(580px, 100%); max-height: min(88vh, 820px); overflow-y: auto; padding: 24px 28px 24px; background: var(--aurora), var(--sheet); border: 1px solid var(--edge); border-radius: 22px; box-shadow: 0 30px 80px -20px rgba(0, 0, 0, 0.45); outline: none; animation: pop 0.16s ease; backdrop-filter: blur(30px); -webkit-backdrop-filter: blur(30px); }
  .pop-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 14px; }
  .pop-title { margin: 8px 0 2px; font-size: 24px; font-weight: 300; line-height: 1.25; letter-spacing: -0.03em; word-break: break-word; }
  .icon-btn { flex: none; width: 30px; height: 30px; border-radius: 50%; border: 1px solid var(--hair-2); background: transparent; font-size: 18px; line-height: 1; cursor: pointer; color: var(--ink-2); }
  .icon-btn:hover { background: var(--row-hover); color: var(--ink); }
  @keyframes fade { from { opacity: 0; } }
  @keyframes pop { from { opacity: 0; transform: translateY(8px) scale(0.98); } }

  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 8px; text-align: left; vertical-align: middle; border-bottom: 1px solid var(--hair); white-space: nowrap; }
  td.wrap { white-space: normal; overflow-wrap: anywhere; }
  th { vertical-align: bottom; font-size: 10px; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }
  tbody tr:last-child td { border-bottom: 0; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  td.cost { font-weight: 600; }
  th:first-child, td:first-child { padding-left: 0; }
  th:last-child, td:last-child { padding-right: 0; }

  .linkbtn { background: none; border: 0; padding: 0; margin-top: 12px; color: var(--ink); cursor: pointer; font-size: 12px; font-weight: 600; text-decoration: underline; text-decoration-color: var(--hair-2); text-underline-offset: 3px; }
  .linkbtn:hover { text-decoration: underline; }
  .linkbtn.inline { margin: 0 0 0 6px; }
  details.fold > summary, .diagnostic > summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 8px; }
  details.fold > summary::-webkit-details-marker, .diagnostic > summary::-webkit-details-marker { display: none; }
  details.fold > summary::before, .diagnostic > summary::before { content: ''; width: 5px; height: 5px; flex: none; border-right: 1.5px solid var(--ink-2); border-bottom: 1.5px solid var(--ink-2); transform: rotate(-45deg); transition: transform 0.12s; }
  details.fold[open] > summary::before, .diagnostic[open] > summary::before { transform: rotate(45deg); }
  details.fold[open] > summary { margin-bottom: 12px; }
  .collection > summary { flex-wrap: wrap; }
  .health-summary { display: inline-flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 4px 14px; margin-left: auto; font-size: 11px; color: var(--ink-2); }
  .health-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
  .ready { color: var(--positive); }
  .attention { color: var(--warn-ink); }
  .health-badge { font-size: 10px; border-radius: 999px; padding: 3px 8px; background: var(--track); white-space: nowrap; }
  .health-chip { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
  .health-chip b { font-weight: 500; color: var(--ink); }
  .health-chip em { font-style: normal; }
  .health-chip.ready { color: var(--positive); }
  .health-chip.attention { color: var(--warn-ink); }
  .health-chip.absent, .health-chip.pending { color: var(--muted); }
  .health-chip.absent b { font-weight: 400; color: var(--muted); }
  .health-chip.absent .dot { background: transparent; box-shadow: inset 0 0 0 1.5px var(--muted); }
  .health-flag { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; }
  .health-note { margin: 12px 0 0; font-size: 12px; color: var(--ink-2); overflow-wrap: anywhere; }
  .health-note code { font-size: 11px; }
  .hero-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px 24px; margin: 12px 0 24px; }
  .hero-row .hero-figure { margin: 0; }
  .hero-left { display: grid; justify-items: start; gap: 14px; flex: 1 1 230px; min-width: 0; }
  .hero-left .pie-legend-wrap { width: 100%; }
  .hero-ring { flex: none; margin-left: auto; }
  [data-pie="cost"] .pie-tokens, [data-pie="tokens"] .pie-cost { display: none; }
  [data-pie="cost"] .chip.share > .share-tokens, [data-pie="tokens"] .chip.share > .share-cost { display: none; }
  .pie-svg { display: block; width: clamp(120px, 36vw, 164px); height: auto; }
  .pie-legend { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; font-size: 12px; min-width: 0; }
  .pie-legend li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto 3.2em; gap: 8px; align-items: center; }
  .pie-legend .swatch { width: 10px; height: 10px; border-radius: 3px; }
  .pie-name { overflow-wrap: anywhere; }
  .pie-name small { display: block; font-size: 10px; color: var(--muted); }
  .pie-legend b { font-weight: 600; font-variant-numeric: tabular-nums; }
  .pie-pct { text-align: right; color: var(--ink-2); font-variant-numeric: tabular-nums; }
  .pie-legend-wrap .note { margin: 8px 0 0; }
  .pie-more { margin-top: 10px; }
  .pie-more > .pie-legend { margin-top: 10px; color: var(--ink); }
  .pie-more > .pie-legend > li { margin-top: 0; }
  .slice { stroke: none; }
  .slice.empty { fill: var(--track); stroke: none; }
  .pie-total { font-size: 12px; font-weight: 300; letter-spacing: -0.01em; fill: var(--ink); font-variant-numeric: tabular-nums; text-rendering: geometricPrecision; }
  .pie-unit { font-size: 4.6px; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase; fill: var(--ink-2); text-rendering: geometricPrecision; }
  .health-facts { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 12px; margin: 14px 0 0; font-size: 12px; }
  .health-facts dt { color: var(--ink-2); }
  .health-facts dd { margin: 0; text-align: right; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .health-issue { color: var(--warn-ink); font-size: 12px; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
  .diagnostic { margin-top: 12px; color: var(--ink-2); font-size: 12px; overflow-wrap: anywhere; }
  .diagnostic code, .diagnostic > .mono { display: block; margin: 8px 0 0; font-size: 11px; }
  .diagnostic > .mono { padding: 1px 4px; border-radius: 4px; background: var(--track); }
  .diagnostic > .mgrid { margin-top: 10px; }
  .diagnostic ~ .banner { margin: 12px 0 0; }
  .collection .banner { font-size: 12px; }
  .diagnostic li { margin-top: 6px; }
  .collection-foot { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 6px 16px; border-top: 1px solid var(--hair); margin-top: 16px; padding-top: 12px; color: var(--ink-2); font-size: 11px; }
  .empty, .note { color: var(--ink-2); margin: 10px 0 0; }
  .note { font-size: 12px; color: var(--muted); }
  .notes { color: var(--ink-2); font-size: 12px; padding-left: 18px; }
  .notes code { font-size: 1em; }

  @media (max-width: 560px) {
    .page { padding: 14px 10px 32px; }
    .card { padding: 18px 16px; border-radius: 18px; }
    .hero-figure { font-size: 58px; }
    .hero-ring { margin: 0 auto; }
    .chart { grid-template-columns: 40px minmax(0, 1fr); column-gap: 4px; }
    .col { position: static; }
    .tip { left: 0; }
    .tip.left-of { left: auto; right: 0; }
    .scard-main { padding: 10px; }
    #popup { padding: 8px; }
    .pop-card { padding: 16px 16px 18px; border-radius: 14px; }
    .tok5 { gap: 4px; }
    .health-summary { justify-content: flex-start; margin-left: 0; width: 100%; }
    .parts li { grid-template-columns: minmax(0, 1fr) auto 56px 34px; gap: 2px 8px; }
    .d-grid { gap: 12px; }
    .facts { grid-template-columns: 1fr; gap: 2px 0; }
    .facts dd { margin-bottom: 8px; }
  }
  @media (max-width: 390px) {
    .tok5 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .rate-foot { overflow-wrap: anywhere; }
    th, td { padding-inline: 5px; }
  }
  @media (prefers-reduced-motion: reduce) {
    details.fold > summary::before, .diagnostic > summary::before { transition: none; }
    #scrim, .pop-card { animation: none; }
  }

  @media (forced-colors: active) {
    .dot, .swatch, .key, .seg, .slice, .hbar i, .meter .fill, .health-dot, .legend-item .dash, .chip.share i { forced-color-adjust: none; }
    .slice { stroke: CanvasText; stroke-width: 0.6; }
    .slice.empty { fill: Canvas; stroke: CanvasText; }
    .pie-total, .pie-unit { fill: CanvasText; }
    .dot, .swatch, .key, .seg { outline: 1px solid CanvasText; outline-offset: -1px; }
    .hbar, .meter { border: 1px solid CanvasText; background: Canvas; }
    .hbar i, .meter .fill, .meter.warning .fill, .meter.critical .fill, .chip.share i { background: Highlight; }
    .chip, .tile { border: 1px solid CanvasText; }
    .meter .tick { border-left-color: CanvasText; }
    .grid, .pace { border-top-color: CanvasText; }
    .legend-item .dash { border-top-color: CanvasText; }
    .segmented button { border: 1px solid ButtonText; }
    .segmented button.active, .segmented button[aria-pressed="true"] { forced-color-adjust: none; background: Highlight; color: HighlightText; }
    .tip, #dashboard-tooltip, .multi-list { background: Canvas; color: CanvasText; border: 1px solid CanvasText; }
    .multi-btn { border-color: ButtonText; }
    .multi-item[aria-pressed="true"] { forced-color-adjust: none; background: Highlight; color: HighlightText; }
    .multi-item[aria-pressed="true"] .menu-check::after { border-color: HighlightText; }
    .hero-figure .int { background: none; color: CanvasText; -webkit-text-fill-color: CanvasText; }
    .col:hover, .col:focus-visible { outline: 2px solid Highlight; }
  }
`;
