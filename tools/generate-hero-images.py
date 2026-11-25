"""
Generate App Store-style hero banner images for agent-usage-dock README.

Creates polished compositions with the actual dashboard screenshots,
gradient backdrops, and floating card effects.
"""
import base64
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HERO_DIR = ROOT / "media" / "hero"
OUT = ROOT / "media" / "readme"
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


def to_data_uri(path: Path) -> str:
    data = base64.b64encode(path.read_bytes()).decode()
    return f"data:image/png;base64,{data}"


# Combined: tagline left + dark/light stacked cards right
COMBINED = """<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@200;300;400;500;600;700&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1280px; height: 720px;
    background: #09090b;
    overflow: hidden;
    font-family: 'Inter', -apple-system, 'Segoe UI', sans-serif;
    position: relative;
  }
  /* Aurora gradient background — same palette as the dashboard */
  .aurora {
    position: absolute; inset: 0;
    background:
      radial-gradient(1000px 600px at 5% 15%, rgba(196, 155, 255, 0.22), transparent 70%),
      radial-gradient(800px 500px at 90% 75%, rgba(255, 138, 92, 0.16), transparent 70%),
      radial-gradient(600px 400px at 45% 100%, rgba(101, 128, 255, 0.12), transparent 70%),
      radial-gradient(400px 300px at 25% 85%, rgba(92, 198, 182, 0.08), transparent 70%);
  }
  .grid-bg {
    position: absolute; inset: 0;
    background-image:
      linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px);
    background-size: 52px 52px;
    mask-image: radial-gradient(ellipse 85% 75% at 60% 50%, black 15%, transparent 70%);
    -webkit-mask-image: radial-gradient(ellipse 85% 75% at 60% 50%, black 15%, transparent 70%);
  }
  .content {
    position: relative; z-index: 2;
    display: flex;
    height: 100%;
    padding: 56px 56px 48px;
    gap: 56px;
    align-items: center;
  }
  /* ---- Left column: branding + tagline ---- */
  .left {
    flex: 0 0 340px;
    display: flex;
    flex-direction: column;
    gap: 22px;
    padding-bottom: 24px;
  }
  .icon-row {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .app-icon {
    width: 50px; height: 50px;
    background: linear-gradient(135deg, #7c9cff 0%, #c49bff 50%, #ff8a5c 100%);
    border-radius: 13px;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 8px 28px rgba(196, 155, 255, 0.3);
  }
  .app-icon svg { width: 28px; height: 28px; }
  .app-name {
    font-size: 13px; font-weight: 500; color: rgba(244, 242, 255, 0.45);
    letter-spacing: 0.1em; text-transform: uppercase;
  }
  h1 {
    font-size: 36px; font-weight: 300; color: #f4f2ff;
    line-height: 1.2; letter-spacing: -0.03em;
  }
  h1 strong {
    font-weight: 600;
    background: linear-gradient(135deg, #c49bff 0%, #ff8a5c 100%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .tagline {
    font-size: 14px; color: rgba(244, 242, 255, 0.4); line-height: 1.7;
    max-width: 320px;
  }
  .badges {
    display: flex; flex-wrap: wrap; gap: 7px; margin-top: 2px;
  }
  .badge {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 12px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.07);
    color: rgba(244, 242, 255, 0.55);
    font-size: 11px; font-weight: 500;
  }
  .badge .dot {
    width: 6px; height: 6px; border-radius: 50%;
  }
  .dot.gemini { background: #c49bff; }
  .dot.claude { background: #ff8a5c; }
  .dot.codex { background: #b0a9c9; }
  .dot.dsh { background: #6580ff; }
  .dot.cursor { background: #5cc6b6; }

  /* ---- Right column: stacked dark + light screenshots ---- */
  .right {
    flex: 1;
    position: relative;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .cards-stack {
    position: relative;
    width: 100%;
    max-width: 800px;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }
  /* Dark card: larger, in front */
  .card-dark {
    position: relative;
    z-index: 2;
    width: 100%;
    transform: perspective(1600px) rotateY(-4deg) rotateX(1.5deg);
    border-radius: 16px;
    overflow: hidden;
    box-shadow:
      0 0 0 1px rgba(255,255,255,0.08),
      0 32px 80px -12px rgba(0,0,0,0.65),
      0 0 60px rgba(196, 155, 255, 0.05);
  }
  .card-dark img { display: block; width: 100%; height: auto; }
  .card-dark::after {
    content: '';
    position: absolute; inset: 0;
    background: linear-gradient(180deg, transparent 55%, rgba(9,9,11,0.5) 100%);
    pointer-events: none;
    border-radius: 16px;
  }
  .card-dark .theme-label {
    position: absolute; top: 12px; right: 16px; z-index: 3;
    font-size: 10px; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase;
    color: rgba(244, 242, 255, 0.4);
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.08);
    padding: 3px 10px; border-radius: 999px;
  }
  /* Light card: behind, peeking from beneath */
  .card-light {
    position: absolute;
    z-index: 1;
    width: 94%;
    bottom: -2%;
    right: -4%;
    transform: perspective(1600px) rotateY(-3.5deg) rotateX(1deg);
    border-radius: 14px;
    overflow: hidden;
    box-shadow:
      0 0 0 1px rgba(255,255,255,0.15),
      0 24px 60px -16px rgba(0,0,0,0.5);
    opacity: 0.45;
  }
  .card-light img { display: block; width: 100%; height: auto; }
  .card-light .theme-label {
    position: absolute; top: 10px; right: 14px; z-index: 3;
    font-size: 10px; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase;
    color: rgba(20, 24, 32, 0.35);
    background: rgba(20, 24, 32, 0.05);
    border: 1px solid rgba(20, 24, 32, 0.08);
    padding: 3px 10px; border-radius: 999px;
  }
</style>
</head><body>
  <div class="aurora"></div>
  <div class="grid-bg"></div>
  <div class="content">
    <div class="left">
      <div class="icon-row">
        <div class="app-icon">
          <svg viewBox="0 0 296 298" fill="none">
            <path fill="white" d="M141.201 4.886c2.282-6.17 11.042-6.071 13.184.148l5.985 17.37a184.004 184.004 0 0 0 111.257 113.049l19.304 6.997c6.143 2.227 6.156 10.91.02 13.155l-19.35 7.082a184.001 184.001 0 0 0-109.495 109.385l-7.573 20.629c-2.241 6.105-10.869 6.121-13.133.025l-7.908-21.296a184 184 0 0 0-109.02-108.658l-19.698-7.239c-6.102-2.243-6.118-10.867-.025-13.132l20.083-7.467A183.998 183.998 0 0 0 133.291 26.28l7.91-21.394Z"/>
          </svg>
        </div>
        <span class="app-name">agent-usage-dock</span>
      </div>
      <h1>Know what your<br><strong>AI agents</strong> cost.</h1>
      <p class="tagline">Offline token tracking for every tool you use. Live dashboard, budget alerts, session breakdown — all from your local logs.</p>
      <div class="badges">
        <span class="badge"><i class="dot gemini"></i>Antigravity</span>
        <span class="badge"><i class="dot claude"></i>Claude</span>
        <span class="badge"><i class="dot codex"></i>Codex</span>
        <span class="badge"><i class="dot dsh"></i>DSH</span>
        <span class="badge"><i class="dot cursor"></i>Cursor</span>
      </div>
    </div>
    <div class="right">
      <div class="cards-stack">
        <div class="card-light">
          <span class="theme-label">Mist</span>
          <img src="LIGHT_IMAGE_DATA_URI" />
        </div>
        <div class="card-dark">
          <span class="theme-label">Noir</span>
          <img src="DARK_IMAGE_DATA_URI" />
        </div>
      </div>
    </div>
  </div>
</body></html>"""


def main():
    screenshots = {
        "hero-dark": HERO_DIR / "dashboard-hero-dark.png",
        "hero-light": HERO_DIR / "dashboard-hero-light.png",
    }

    for name, path in screenshots.items():
        if not path.exists():
            print(f"Missing screenshot: {path}")
            sys.exit(1)

    print("Encoding screenshots...")
    data_uris = {name: to_data_uri(path) for name, path in screenshots.items()}

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=find_browser(), headless=True)

        # Combined hero
        print("Generating combined hero...")
        html = COMBINED.replace(
            "DARK_IMAGE_DATA_URI", data_uris["hero-dark"]
        ).replace(
            "LIGHT_IMAGE_DATA_URI", data_uris["hero-light"]
        )
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        page.set_content(html, wait_until="networkidle")
        page.wait_for_timeout(1500)
        page.screenshot(path=str(OUT / "hero-banner.png"))
        page.close()
        print(f"  Saved: {OUT / 'hero-banner.png'}")

        browser.close()

    print(f"\nDone. Hero image: {OUT / 'hero-banner.png'}")


if __name__ == "__main__":
    main()
