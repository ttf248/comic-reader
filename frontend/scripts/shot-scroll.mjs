// 视口截图：应用的内容区是内层滚动容器，fullPage 截不到下半屏。
// 用法：node scripts/shot-scroll.mjs --route /photo/travels --scroll 900 --out .smoke/x.png
import { chromium } from '@playwright/test'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}

const ROUTE = arg('route', '/')
const OUT = arg('out', '.smoke/scroll.png')
const SCROLL = Number(arg('scroll', '0'))
const THEME = arg('theme', 'light')
const WIDTH = Number(arg('width', '1440'))
const HEIGHT = Number(arg('height', '900'))
const BASE = process.env.LG_BASE ?? 'http://127.0.0.1:5173'

const browser = await chromium.launch()
const page = await browser.newPage({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 1,
})
await page.goto(BASE + ROUTE, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page
  .waitForFunction(
    () => Array.from(document.images).every((img) => !img.complete || img.naturalWidth > 0),
    undefined,
    { timeout: 20000 },
  )
  .catch(() => {})
await page.waitForTimeout(1200)
if (SCROLL > 0) {
  await page.evaluate((top) => {
    // 内容区是内层滚动容器：挑第一个能滚的祖先。
    const candidates = Array.from(document.querySelectorAll('div')).filter(
      (node) => node.scrollHeight > node.clientHeight + 40,
    )
    const container = candidates.sort(
      (a, b) => b.clientHeight - a.clientHeight,
    )[0]
    if (container) container.scrollTop = top
    else window.scrollTo(0, top)
  }, SCROLL)
  await page.waitForTimeout(700)
}
await page.screenshot({ path: OUT })
console.log(`-> ${OUT}`)
await browser.close()
