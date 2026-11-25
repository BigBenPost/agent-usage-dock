"""
Exercise the generated dashboard's CSP and real keyboard focus in Chromium.

Run `npm test` first: the fixtures are rendered from the compiled code in out/.

  uv run --no-project --with playwright==1.60.0 python -B tools/browser_test_dashboard.py

The offline snapshot uses file:// by default. Where browser policy blocks local files,
AGY_TEST_OFFLINE_HTTP=1 tests the same generated HTML through a loopback route instead;
that mode does not validate file:// support.

The browser is the executable named by PLAYWRIGHT_CHROMIUM_EXECUTABLE if that is set. Otherwise the script looks for Chromium,
Chrome or Edge on PATH and in the usual install folders of macOS and Windows, then falls back to a Chromium that Playwright
installed itself. Example for Chrome on macOS:

  PLAYWRIGHT_CHROMIUM_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" uv run --no-project --with playwright==1.60.0 python -B tools/browser_test_dashboard.py
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest

from playwright.sync_api import Error as PlaywrightError, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = r"""
const {renderPage,renderBody}=require('./out/src/panelHtml');
const {aggregate}=require('./out/src/reconcile');
const {summarize}=require('./out/src/summary');
const {Pricing}=require('./out/src/pricing');
const {normalizeConfig}=require('./out/src/configValues');
const cfg=normalizeConfig({});
const facts=aggregate({one:{id:'one',source:'antigravity',day:'2026-11-22',model:'gemini-1.5-flash',session:'s',tokens:{input:100,output:10,cacheRead:0,cacheWrite:0,cacheWrite1h:0}}});
const summary=summarize(facts,new Pricing(),Date.parse('2026-11-22'));
process.stdout.write(JSON.stringify({page:renderPage(summary,cfg),body:renderBody(summary,cfg)}));
"""

PAGED_FIXTURE = r"""
const {renderPage,renderBody,renderSessionDetail,sessionView}=require('./out/src/panelHtml');
const {aggregate}=require('./out/src/reconcile');
const {summarize}=require('./out/src/summary');
const {buildSessionDetail}=require('./out/src/sessionDetail');
const {Pricing}=require('./out/src/pricing');
const {normalizeConfig}=require('./out/src/configValues');
const ts=Date.parse('2026-11-22T08:00:00Z');
const cfg=normalizeConfig({tokenBudgetLimit:1});
const model='local-model-'+'abc'.repeat(27);
const pricing=new Pricing({[model]:{input:2,output:10}});
const records=Array.from({length:22},(_,i)=>({id:'r'+i,source:i<4?'antigravity':'codex',
  day:'2026-11-22',model,session:'s'+i,ts:ts+i*1000,
  tokens:{input:2e6+i,output:1e6,cacheRead:0,cacheWrite:0,cacheWrite1h:0}}));
const facts=aggregate(Object.fromEntries(records.map(record=>[record.id,record])));
const summary=summarize(facts,pricing,ts);
const view=sessionView({sources:['codex'],sort:'last:desc',page:0});
const detail=renderSessionDetail(buildSessionDetail('codex:s21',facts.sessions['codex:s21'],pricing,'2026-11'));
process.stdout.write(JSON.stringify({page:renderPage(summary,cfg), filtered:renderBody(summary,cfg,view),
  next:renderBody(summary,cfg,{...view,page:1}),detail}));
"""


BROWSER_COMMANDS = ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome", "microsoft-edge", "msedge")


def installed_browsers():
    macos = [
        "Google Chrome.app/Contents/MacOS/Google Chrome",
        "Chromium.app/Contents/MacOS/Chromium",
        "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ]
    windows = [
        r"Google\Chrome\Application\chrome.exe",
        r"Chromium\Application\chrome.exe",
        r"Microsoft\Edge\Application\msedge.exe",
    ]
    for folder in (Path("/Applications"), Path.home() / "Applications"):
        yield from (folder / relative for relative in macos)
    for variable in ("ProgramFiles", "ProgramFiles(x86)", "LocalAppData"):
        if os.environ.get(variable):
            yield from (Path(os.environ[variable]) / relative for relative in windows)


def chromium_path():
    configured = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE")
    if configured:
        return configured
    found = next((path for name in BROWSER_COMMANDS if (path := shutil.which(name))), None)
    return found or next((str(path) for path in installed_browsers() if path.is_file()), None)


def launch(runtime):
    try:
        return runtime.chromium.launch(executable_path=chromium_path(), headless=True)
    except PlaywrightError as error:
        raise RuntimeError(
            "Could not start a browser. Install Chromium, Chrome or Edge, or set PLAYWRIGHT_CHROMIUM_EXECUTABLE "
            "to the browser executable."
        ) from error


class DashboardBrowserTests(unittest.TestCase):
    def test_modal_focus_and_live_replacement_under_generated_csp(self):
        fixture = json.loads(subprocess.check_output(["node", "-e", FIXTURE], cwd=ROOT))
        with sync_playwright() as runtime:
            browser = launch(runtime)
            try:
                page = browser.new_page()
                page.route("http://127.0.0.1/dashboard", lambda route: route.fulfill(content_type="text/html", body=fixture["page"]))
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.add_init_script("window.messages=[];window.acquireVsCodeApi=()=>({getState:()=>null,setState:()=>{},postMessage:m=>window.messages.push(m)});")
                page.goto("http://127.0.0.1/dashboard")
                self.assertEqual(page.evaluate("window.messages[0].type"), "ready")
                page.locator(".scard-main").click()
                self.assertTrue(page.locator("#app").evaluate("e=>e.inert"))
                page.keyboard.press("Tab")
                self.assertEqual(page.evaluate("document.activeElement.id"), "pop-card")
                detail = '<button data-action="close">Close</button><button data-action="open-log">Open log</button>'
                send = lambda value: page.evaluate("m=>window.dispatchEvent(new MessageEvent('message',{data:m}))", value)
                send({"type": "detail", "key": "antigravity:s", "html": detail})
                page.keyboard.press("Tab")
                self.assertEqual(page.evaluate("document.activeElement.dataset.action"), "close")
                page.keyboard.press("Shift+Tab")
                self.assertEqual(page.evaluate("document.activeElement.dataset.action"), "open-log")
                send({"type": "detail", "key": "antigravity:s", "html": detail.replace("Open log", "Updated log")})
                self.assertEqual(page.evaluate("document.activeElement.dataset.action"), "open-log")
                send({"type": "render", "theme": "dark", "html": fixture["body"]})
                self.assertEqual(page.evaluate("document.activeElement.dataset.action"), "open-log")
                page.keyboard.press("Tab")
                self.assertEqual(page.evaluate("document.activeElement.dataset.action"), "close")
                page.keyboard.press("Escape")
                self.assertFalse(page.locator("#app").evaluate("e=>e.inert"))
                self.assertTrue(page.locator(".scard-main").evaluate("e=>e===document.activeElement"))
                page.locator(".scard-main").click()
                send({"type": "render", "theme": "light", "html": ""})
                page.keyboard.press("Escape")
                self.assertEqual(page.evaluate("document.activeElement.id"), "app")
                self.assertEqual(errors, [])
            finally:
                browser.close()

    def test_pagination_filter_focus_and_long_names_in_narrow_panel(self):
        fixture = json.loads(subprocess.check_output(["node", "-e", PAGED_FIXTURE], cwd=ROOT))
        with sync_playwright() as runtime:
            browser = launch(runtime)
            try:
                for width, theme in ((320, "light"), (390, "dark"), (1200, "light")):
                    with self.subTest(width=width, theme=theme):
                        page = browser.new_page(viewport={"width": width, "height": 800}, reduced_motion="reduce")
                        try:
                            page.route("http://127.0.0.1/dashboard", lambda route: route.fulfill(content_type="text/html", body=fixture["page"]))
                            page.add_init_script("window.messages=[];window.acquireVsCodeApi=()=>({getState:()=>null,setState:()=>{},postMessage:m=>window.messages.push(m)});")
                            page.goto("http://127.0.0.1/dashboard")
                            send = lambda value: page.evaluate("m=>window.dispatchEvent(new MessageEvent('message',{data:m}))", value)
                            active = lambda: page.evaluate("document.activeElement.getAttribute('data-focus')")
                            self.assertEqual(page.locator(".scard[data-key]").count(), 15)
                            menu = page.locator("[data-multi-toggle]")
                            menu.click()
                            self.assertEqual(menu.get_attribute("aria-expanded"), "true")
                            everything = page.locator("[data-filter-all]")
                            self.assertTrue(everything.is_checked())
                            everything.click()
                            self.assertTrue(everything.is_checked(), "no tool picked is every tool, so the box cannot be cleared")
                            self.assertEqual(page.evaluate("messages.at(-1).view"), {"sort": "last:desc", "sources": [], "page": 0})
                            page.locator("[data-filter=antigravity]").click()
                            self.assertEqual(page.evaluate("messages.at(-1).view"), {"sort": "last:desc", "sources": ["codex"], "page": 0})
                            self.assertFalse(everything.is_checked())
                            send({"type": "render", "theme": theme, "html": fixture["filtered"]})
                            self.assertEqual(active(), "filter-antigravity")
                            self.assertTrue(page.locator("[data-filter=codex]").is_checked())
                            self.assertFalse(page.locator("[data-filter=antigravity]").is_checked())
                            self.assertFalse(page.locator("[data-filter-all]").is_checked())
                            self.assertEqual(page.locator("[data-multi-toggle] .multi-label").text_content(), "Codex")
                            self.assertIn("18 sessions in November", page.locator(".slist").evaluate("e=>e.previousElementSibling.textContent"))
                            filter_box = page.locator("[data-multi-toggle]").bounding_box()
                            sort_btn = page.locator("[data-focus=session-sort]")
                            sort_box = sort_btn.bounding_box()
                            self.assertAlmostEqual(filter_box["height"], sort_box["height"], delta=0.5)
                            sort_btn.click()
                            self.assertEqual(sort_btn.get_attribute("aria-expanded"), "true")
                            list_box = page.locator("#sort-menu-list").bounding_box()
                            card_box = page.locator(".sortbar").locator("xpath=ancestor::section[1]").bounding_box()
                            self.assertGreaterEqual(list_box["x"], card_box["x"])
                            self.assertLessEqual(list_box["x"] + list_box["width"], card_box["x"] + card_box["width"])
                            page.locator("[data-sort-option='cost:desc']").click()
                            self.assertEqual(page.evaluate("messages.at(-1).view.sort"), "cost:desc")
                            self.assertEqual(active(), "session-sort")
                            send({"type": "render", "theme": theme, "html": fixture["filtered"]})
                            self.assertEqual(active(), "session-sort")
                            meter = page.get_by_role("meter")
                            self.assertEqual(meter.get_attribute("aria-valuenow"), meter.get_attribute("aria-valuemax"))
                            page.locator("[data-focus='session-codex:s21']").click()
                            send({"type": "detail", "key": "codex:s21", "html": fixture["detail"]})
                            client, content = page.locator("#pop-card").evaluate("e=>[e.clientWidth,e.scrollWidth]")
                            self.assertLessEqual(content, client + 1)
                            page.keyboard.press("Escape")
                            page.locator("[data-focus=sessions-next]").click()
                            self.assertEqual(page.evaluate("messages.at(-1).view.page"), 1)
                            send({"type": "render", "theme": theme, "html": fixture["next"]})
                            self.assertEqual(page.locator(".scard[data-key]").count(), 3)
                            self.assertEqual(active(), "sessions-prev")
                            page.locator("[data-action=configure-rates]").click()
                            self.assertEqual(page.evaluate("messages.at(-1).type"), "configureRates")
                        finally:
                            page.close()
            finally:
                browser.close()

    def test_offline_html_export_via_file_url(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            html_path = Path(tmp) / "offline-export.html"
            node_script = r"""
const fs = require('fs');
const path = require('path');
const { buildOfflineSnapshot, renderOfflineHtml } = require('./out/src/offlineExport');
const { normalizeConfig } = require('./out/src/configValues');
const { emptyBucket } = require('./out/src/types');
const now = Date.parse('2026-11-22T12:00:00Z');
const bucket = (requests, input, output) => ({ ...emptyBucket(), requests, input, output });
const tmpDir = process.argv[1];
const claudeDir = path.join(tmpDir, 'claude');
const projDir = path.join(claudeDir, 'projects', 'p');
fs.mkdirSync(projDir, { recursive: true });
fs.writeFileSync(
  path.join(projDir, 'cross.jsonl'),
  JSON.stringify({ type: 'user', cwd: '/work/</script><img src=x onerror="window.xss=1">', gitBranch: 'main', message: { content: 'Hello </script><script>window.xss=2</script>' } }) + '\n'
);
const days = {
  '2026-09-05': { claude: { 'claude-sonnet-5-5': bucket(1, 1e6, 0) } },
  '2026-10-15': { claude: { 'claude-sonnet-5-5': bucket(2, 1e6, 5e5) } },
  '2026-11-22': { claude: { 'claude-sonnet-5-5': bucket(3, 2e6, 1e6) }, codex: { 'gpt-5.5': bucket(1, 5e5, 2e5) } },
};
const sessions = {
  'claude:cross': {
    source: 'claude', id: 'cross', title: 'Cross </script><script>window.xss=3</script>', project: 'p',
    first: Date.parse('2026-10-15T10:00:00Z'), last: now - 60000,
    days: { '2026-10-15': { 'claude-sonnet-5-5': bucket(2, 1e6, 5e5) }, '2026-11-22': { 'claude-sonnet-5-5': bucket(1, 1e6, 5e5) } },
  },
};
for (let i = 0; i < 18; i++) {
  sessions['codex:s' + i] = {
    source: 'codex', id: 's' + i, project: 'proj-' + i,
    first: now - (i + 2) * 3600000, last: now - (i + 1) * 60000,
    days: { '2026-11-22': { 'gpt-5.5': bucket(1, 1e5, 5e4) } },
  };
}
const cfg = normalizeConfig({ dashboardTheme: 'auto', timeZone: 'SGT', correctionFactor: 1.5, claudeHome: claudeDir, codexHome: path.join(tmpDir, 'codex'), antigravityHome: path.join(tmpDir, 'agy'), dshHome: path.join(tmpDir, 'dsh') });
const legacy = { days: { '2026-09-05': { claude: { 'claude-sonnet-5-5': bucket(1, 1e6, 0) } } }, before: Date.parse('2026-09-06T00:00:00Z') };
(async () => {
  const snap = await buildOfflineSnapshot({ days, sessions, firstDay: '2026-09-05', legacy, files: { [path.join(projDir, 'cross.jsonl')]: { size: 10, offset: 10, mtimeMs: now - 10000, source: 'claude', session: 'cross' } } }, cfg, { pluginVersion: '1.3.0', now, resolvedTheme: 'dark' });
  const html = renderOfflineHtml(snap);
  fs.writeFileSync(path.join(tmpDir, 'offline-export.html'), html, 'utf8');
})();
"""
            subprocess.check_call(["node", "-e", node_script, tmp], cwd=ROOT)
            file_url = html_path.resolve().as_uri()
            offline_http = os.environ.get("AGY_TEST_OFFLINE_HTTP") == "1"
            if offline_http:
                file_url = "http://127.0.0.1/offline-export.html"
            with sync_playwright() as runtime:
                browser = launch(runtime)
                try:
                    for width in (320, 1100):
                        with self.subTest(width=width):
                            page = browser.new_page(viewport={"width": width, "height": 800})
                            if offline_http:
                                page.route(file_url, lambda route: route.fulfill(content_type="text/html", body=html_path.read_text()))
                            errors = []
                            network_requests = []
                            page.on("pageerror", lambda err: errors.append(str(err)))
                            page.on("request", lambda req: network_requests.append(req.url))
                            try:
                                page.goto(file_url)
                                self.assertEqual(network_requests, [file_url])
                                self.assertIsNone(page.evaluate("window.xss"))
                                self.assertEqual(page.locator("[data-action=configure-rates]").count(), 0)
                                self.assertIn("Offline snapshot", page.locator(".meta").text_content())
                                self.assertEqual(page.locator(".scard[data-key]").count(), 15)
                                page.locator("[data-focus=sessions-next]").click()
                                self.assertEqual(page.locator(".scard[data-key]").count(), 4)
                                page.locator("[data-focus=session-sort]").click()
                                page.locator("[data-sort-option='cost:desc']").click()
                                page.locator("[data-multi-toggle]").click()
                                page.locator("[data-filter=codex]").click()
                                page.keyboard.press("Escape")
                                self.assertEqual(page.locator(".scard[data-key]").count(), 1)
                                page.locator("[data-focus='session-claude:cross']").click()
                                self.assertEqual(page.locator("[data-action=open-log]").count(), 0)
                                self.assertIn("Active at export", page.locator("#pop-card").text_content())
                                self.assertIn("November 2026", page.locator("#pop-card").text_content())
                                page.keyboard.press("Escape")
                                page.locator("[data-zone=UTC]").click()
                                self.assertEqual(page.locator("[data-zone=UTC]").get_attribute("aria-pressed"), "true")
                                page.locator("[data-pie-set=tokens]").click()
                                self.assertEqual(page.locator("[data-pie-set=tokens]").get_attribute("aria-pressed"), "true")
                                page.locator("[data-menu-toggle='month']").click()
                                page.locator("[data-menu='month'] [data-month='2026-09']").click()
                                self.assertIn("September 2026", page.locator("header.top").text_content())
                                page.locator("[data-menu-toggle='month']").click()
                                page.locator("[data-menu='month'] [data-month='2026-10']").click()
                                self.assertIn("October 2026", page.locator("header.top").text_content())
                                page.locator("[data-zone=SGT]").click()
                                self.assertIn("October 2026", page.locator("header.top").text_content())
                                page.locator("[data-focus=session-sort]").click()
                                page.locator("[data-sort-option='last:desc']").click()
                                self.assertIn("October 2026", page.locator("header.top").text_content())
                                page.locator("[data-focus='session-claude:cross']").click()
                                self.assertIn("October 2026", page.locator("#pop-card").text_content())
                                page.keyboard.press("Escape")
                                overflow = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
                                self.assertLessEqual(overflow, 1)
                                self.assertEqual(errors, [])
                            finally:
                                page.close()
                finally:
                    browser.close()


if __name__ == "__main__":
    unittest.main()
