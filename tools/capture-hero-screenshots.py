"""
Capture hero screenshots of the agent-usage-dock dashboard for README.
Renders both light and dark themes at a wide viewport, then crops the hero area.
"""
import json
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "media" / "hero"
OUT.mkdir(parents=True, exist_ok=True)

def find_browser():
    import os, shutil
    configured = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE")
    if configured:
        return configured
    commands = ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome", "microsoft-edge", "msedge")
    found = next((path for name in commands if (path := shutil.which(name))), None)
    if found:
        return found
    windows = [
        r"Google\Chrome\Application\chrome.exe",
        r"Chromium\Application\chrome.exe",
        r"Microsoft\Edge\Application\msedge.exe",
    ]
    for variable in ("ProgramFiles", "ProgramFiles(x86)", "LocalAppData"):
        if os.environ.get(variable):
            for relative in windows:
                path = Path(os.environ[variable]) / relative
                if path.is_file():
                    return str(path)
    return None

def main():
    print("Rendering dashboard HTML...")
    fixture = json.loads(subprocess.check_output(
        ["node", "tools/render-hero-screenshots.js"],
        cwd=ROOT
    ))

    with sync_playwright() as p:
        browser_path = find_browser()
        print(f"Using browser: {browser_path}")
        browser = p.chromium.launch(executable_path=browser_path, headless=True)

        for theme in ("light", "dark"):
            print(f"Capturing {theme} theme...")

            # Full dashboard at a wide viewport
            page = browser.new_page(viewport={"width": 1200, "height": 900})
            page.add_init_script(
                "window.acquireVsCodeApi=()=>({getState:()=>null,setState:()=>{},postMessage:()=>{}});"
            )
            html_body = fixture[theme]
            def fulfill_route(route):
                route.fulfill(content_type="text/html", body=html_body)
            page.route("http://127.0.0.1/dashboard", fulfill_route)
            page.goto("http://127.0.0.1/dashboard")
            page.wait_for_timeout(500)

            # Full-page screenshot
            full = OUT / f"dashboard-full-{theme}.png"
            page.screenshot(path=str(full), full_page=True)
            print(f"  Full page: {full}")

            # Hero area: the top card pair (token usage + daily chart)
            hero = OUT / f"dashboard-hero-{theme}.png"
            pair = page.locator(".pair").first
            pair.screenshot(path=str(hero))
            print(f"  Hero pair: {hero}")

            # Just the hero cost card with the ring
            cost_card = OUT / f"dashboard-cost-{theme}.png"
            hero_card = page.locator(".card.hero").first
            hero_card.screenshot(path=str(cost_card))
            print(f"  Cost card: {cost_card}")

            # Daily chart card
            chart_card = OUT / f"dashboard-chart-{theme}.png"
            gchart = page.locator(".card.gchart").first
            gchart.screenshot(path=str(chart_card))
            print(f"  Chart card: {chart_card}")

            # Model cards section
            model_section = OUT / f"dashboard-models-{theme}.png"
            models = page.locator("[data-key='by-model']").first
            models.screenshot(path=str(model_section))
            print(f"  Model cards: {model_section}")

            # Session section
            session_section = OUT / f"dashboard-sessions-{theme}.png"
            sessions = page.locator(".slist").first.locator("..") 
            sessions.screenshot(path=str(session_section))
            print(f"  Sessions: {session_section}")

            page.close()

        browser.close()

    print(f"\nAll screenshots saved to {OUT}")

if __name__ == "__main__":
    main()
