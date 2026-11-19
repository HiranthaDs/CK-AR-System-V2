import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { marked } from 'marked'
import { chromium } from 'playwright-core'

const root = resolve(import.meta.dirname, '..')
const sourcePath = resolve(root, 'docs', 'CK_SYS_V3_USER_MANUAL.md')
const htmlPath = resolve(root, 'docs', 'CK_SYS_V3_USER_MANUAL.html')
const pdfPath = resolve(root, 'docs', 'CK_SYS_V3_USER_MANUAL.pdf')

const css = `
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
`

const source = readFileSync(sourcePath, 'utf8')
const body = await marked.parse(source, { gfm: true })
const document = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CK SYS V3 - Complete User Manual</title>
<style>${css}</style>
</head>
<body><main>${body}</main></body>
</html>
`
writeFileSync(htmlPath, document, 'utf8')

const executablePath = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find(existsSync)
if (!executablePath) throw new Error('Microsoft Edge or Google Chrome is required to build the PDF manual.')

const browser = await chromium.launch({ headless: true, executablePath })
try {
  const page = await browser.newPage()
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' })
  const failedImages = await page.locator('img').evaluateAll((images) => images
    .filter((image) => !image.complete || image.naturalWidth === 0)
    .map((image) => image.src))
  if (failedImages.length) throw new Error(`Manual contains images that could not be loaded: ${failedImages.join(', ')}`)
  await page.pdf({
    path: pdfPath, format: 'A4', printBackground: true,
    margin: { top: '14mm', right: '12mm', bottom: '16mm', left: '12mm' },
    displayHeaderFooter: true, headerTemplate: '<span></span>',
    footerTemplate: '<div style="font-size:8px;color:#667085;width:100%;padding:0 12mm;display:flex;justify-content:space-between"><span>CK SYS V3 — Complete User Manual</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
  })
} finally {
  await browser.close()
}

console.log(`Built ${htmlPath}`)
console.log(`Built ${pdfPath}`)
console.log(`Verified ${(body.match(/<img /g) || []).length} embedded screenshot references`)
