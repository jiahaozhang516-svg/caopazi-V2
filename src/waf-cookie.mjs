// 用本机 Edge 过瑞数挑战，拿到该浏览器生成的合法 WAF cookie（O/P 一对）。
//
// 关键实测结论（2026-11-13）：
//   · 有头 Edge：直接过，reload 200
//   · 无头 Edge（默认 UA 带 HeadlessChrome）：被识别，P 只有 364 但 reload 400
//   · 无头 Edge + CDP 覆盖 UA 为普通 Edge UA：过，和真浏览器一致
//   → 所以这里默认「无头 + 覆盖 UA」，后台静默跑，不需要弹窗。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
export const DESKTOP_UA =
  process.env.SEAT_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @returns {Promise<{cookies: Record<string,string>, ua: string, finalUrl: string, title: string, ms: number}>}
 */
export async function fetchWafCookie(opts = {}) {
  const url = opts.url || 'https://libseat.njfu.edu.cn/'
  const headed = !!opts.headed
  const ua = opts.ua || DESKTOP_UA
  const timeoutMs = opts.timeoutMs || 60000
  const log = opts.log || (() => {})
  const t0 = Date.now()

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rsprof-'))
  const args = [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=Translate,OptimizationHints',
    '--disable-extensions',
    '--mute-audio',
    '--window-size=1366,900',
  ]
  if (!headed) {
    args.push('--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-position=-32000,-32000')
  }
  args.push('about:blank')

  const child = spawn(EDGE, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d.toString() })
  const cleanup = () => { try { child.kill() } catch {} ; try { fs.rmSync(profile, { recursive: true, force: true }) } catch {} }

  try {
    // 等 DevToolsActivePort
    const portFile = path.join(profile, 'DevToolsActivePort')
    let port = 0
    for (let i = 0; i < 120; i++) {
      try {
        const first = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]
        if (first) { port = Number(first); break }
      } catch {}
      await sleep(100)
    }
    if (!port) throw new Error('浏览器没起来：' + stderr.slice(0, 500))

    const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
    if (!r.ok) throw new Error('建标签页失败 ' + r.status)
    const target = await r.json()

    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP ws 连接失败')) })

    let id = 0
    const pending = new Map()
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (!m.id || !pending.has(m.id)) return
      const p = pending.get(m.id); pending.delete(m.id)
      if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result)
    }
    const send = (method, params = {}) => {
      const mid = ++id
      ws.send(JSON.stringify({ id: mid, method, params }))
      return new Promise((res, rej) => {
        pending.set(mid, { res, rej })
        setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('CDP 超时 ' + method)) } }, 20000)
      })
    }
    const evalJs = async (expr) => {
      const r0 = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
      return r0.result ? r0.result.value : undefined
    }

    await send('Network.enable')
    await send('Page.enable')
    await send('Runtime.enable')
    // 无头浏览器默认 UA 带 HeadlessChrome，会被瑞数直接判死（reload 400）。
    await send('Network.setUserAgentOverride', { userAgent: ua, acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8', platform: 'Win32' })
    await send('Page.navigate', { url })

    let cookies = []
    let finalUrl = ''
    let title = ''
    let pLen = 0
    while (Date.now() - t0 < timeoutMs) {
      await sleep(400)
      try {
        const c = await send('Network.getCookies', { urls: [url] })
        cookies = c.cookies || []
      } catch {}
      const p = cookies.find((x) => x.name.endsWith('P') && x.value.length > 100)
      if (p) {
        pLen = p.value.length
        finalUrl = (await evalJs('location.href')) || ''
        title = (await evalJs('document.title')) || ''
        // 标题出现 = 挑战后的正式页面已经渲染出来（400 页 title 为空）
        if (title) break
      }
    }
    try { await send('Browser.close') } catch {}

    if (!pLen) throw new Error('没拿到 P cookie' + (stderr ? '：' + stderr.slice(0, 300) : ''))
    if (!title) throw new Error('挑战没有通过（P=' + pLen + '，finalUrl=' + finalUrl + '）')

    return {
      cookies: Object.fromEntries(cookies.map((c) => [c.name, c.value])),
      ua, finalUrl, title,
      ms: Date.now() - t0,
    }
  } finally {
    cleanup()
  }
}
