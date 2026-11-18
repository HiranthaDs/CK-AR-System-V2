"""Build browser and print editions of the CK SYS V3 user manual.

Requires the documentation-only ``Markdown`` package and the Playwright package
already present in the backend development environment.
"""

from __future__ import annotations

from pathlib import Path

import markdown
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs" / "CK_SYS_V3_USER_MANUAL.md"
HTML_OUTPUT = ROOT / "docs" / "CK_SYS_V3_USER_MANUAL.html"
PDF_OUTPUT = ROOT / "docs" / "CK_SYS_V3_USER_MANUAL.pdf"

CSS = """
:root { color-scheme: light; --ink: #14213d; --blue: #2458de; --line: #d8e0ee; --soft: #f4f7fb; }
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; color: var(--ink); background: #e9eef6; font: 15px/1.58 "Segoe UI", Arial, sans-serif; }
main { width: min(1120px, calc(100% - 40px)); margin: 28px auto; padding: 56px 68px; background: #fff; box-shadow: 0 12px 40px #23345a1c; }
h1, h2, h3, h4 { color: #0c1933; line-height: 1.2; page-break-after: avoid; }
h1 { margin-top: 0; font-size: 36px; border-bottom: 4px solid var(--blue); padding-bottom: 18px; }
h2 { margin-top: 48px; padding-bottom: 9px; border-bottom: 2px solid var(--line); font-size: 27px; }
h3 { margin-top: 30px; font-size: 20px; }
h4 { margin-top: 22px; font-size: 17px; }
p, li { orphans: 3; widows: 3; }
a { color: #1749c8; text-decoration: none; }
a:hover { text-decoration: underline; }
blockquote { margin: 22px 0; padding: 14px 18px; border-left: 5px solid #ef9d20; background: #fff8e8; }
blockquote p { margin: 0; }
code { padding: 2px 5px; border-radius: 4px; background: #eef2f8; font-family: Consolas, monospace; }
pre { padding: 18px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; background: #10192d; color: #f7f9ff; page-break-inside: avoid; }
pre code { padding: 0; background: transparent; }
table { width: 100%; margin: 18px 0 26px; border-collapse: collapse; font-size: 13.5px; page-break-inside: avoid; }
th, td { padding: 9px 10px; border: 1px solid var(--line); text-align: left; vertical-align: top; }
th { background: #eaf0ff; }
tr:nth-child(even) td { background: #f8faff; }
img { display: block; max-width: 100%; height: auto; margin: 22px auto 32px; border: 1px solid #cfd8e8; border-radius: 8px; box-shadow: 0 5px 18px #1d31551a; page-break-inside: avoid; }
hr { margin: 40px 0; border: 0; border-top: 1px solid var(--line); }
ul, ol { padding-left: 26px; }
li { margin: 5px 0; }
input[type="checkbox"] { margin-right: 8px; }
@page { size: A4; margin: 14mm 12mm 16mm; }
@media print {
  body { background: #fff; font-size: 10.3pt; }
  main { width: 100%; margin: 0; padding: 0; box-shadow: none; }
  h1 { font-size: 25pt; }
  h2 { margin-top: 24pt; font-size: 18pt; }
  h3 { font-size: 14pt; }
  table { font-size: 8.6pt; }
  a { color: inherit; }
  img { max-height: 238mm; box-shadow: none; }
}
"""


def build() -> None:
    source = SOURCE.read_text(encoding="utf-8")
    body = markdown.markdown(
        source,
        extensions=["extra", "sane_lists", "toc"],
        output_format="html5",
    )
    document = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CK SYS V3 - Complete User Manual</title>
<style>{CSS}</style>
</head>
<body><main>{body}</main></body>
</html>
"""
    HTML_OUTPUT.write_text(document, encoding="utf-8")

    edge = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
    if not edge.exists():
        edge = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=str(edge))
        page = browser.new_page()
        page.goto(HTML_OUTPUT.as_uri(), wait_until="networkidle")
        failed_images = page.locator("img").evaluate_all(
            "images => images.filter(image => !image.complete || image.naturalWidth === 0).map(image => image.src)"
        )
        if failed_images:
            raise RuntimeError(f"Manual contains images that could not be loaded: {failed_images}")
        page.pdf(
            path=str(PDF_OUTPUT),
            format="A4",
            print_background=True,
            margin={"top": "14mm", "right": "12mm", "bottom": "16mm", "left": "12mm"},
            display_header_footer=True,
            header_template="<span></span>",
            footer_template=(
                '<div style="font-size:8px;color:#667085;width:100%;padding:0 12mm;'
                'display:flex;justify-content:space-between">'
                '<span>CK SYS V3 — Complete User Manual</span>'
                '<span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>'
            ),
        )
        browser.close()

    print(f"Built {HTML_OUTPUT}")
    print(f"Built {PDF_OUTPUT}")
    print(f"Verified {body.count('<img ')} embedded screenshot references")


if __name__ == "__main__":
    build()
