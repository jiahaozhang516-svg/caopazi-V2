// 一个最小的 CDP 浏览器封装：启动无头 Edge、开页、在页面里执行 JS、关掉
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
export const DESKTOP_UA =
  process.env.SEAT_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class Browser {
  constructor() {
    this.child = null
    this.ws = null
    this.id = 0
    this.pending = new Map()
    this.profile = ''
  }

  async launch({ headed = false, ua = DESKTOP_UA, startUrl = 'about:blank' } = {}) {
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rsrun-'))
    const args = [
      `--user-data-dir=${this.profile}`,
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
    if (!headed) args.push('--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-position=-32000,-32000')
    args.push(startUrl)

    this.child = spawn(EDGE, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    this.child.stderr.on('data', (d) => { stderr += d.toString() })

    const portFile = path.join(this.profile, 'DevToolsActivePort')
    let port = 0
    for (let i = 0; i < 150; i++) {
      try {
        const first = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]
        if (first) { port = Number(first); break }
      } catch {}
      await sleep(100)
    }
    if (!port) throw new Error('浏览器没起来：' + stderr.slice(0, 400))

    const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(startUrl)}`, { method: 'PUT' })
    if (!r.ok) throw new Error('建标签页失败 ' + r.status)
    const target = await r.json()

    this.ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('CDP 连接失败')) })
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (!m.id || !this.pending.has(m.id)) return
      const p = this.pending.get(m.id); this.pending.delete(m.id)
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result)
    }

    await this.send('Network.enable')
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('Network.setUserAgentOverride', {
      userAgent: ua,
      acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
      platform: 'Win32',
    })
    return this
  }

  send(method, params = {}, timeout = 30000) {
    const mid = ++this.id
    this.ws.send(JSON.stringify({ id: mid, method, params }))
    return new Promise((res, rej) => {
      this.pending.set(mid, { res, rej })
      setTimeout(() => { if (this.pending.has(mid)) { this.pending.delete(mid); rej(new Error('CDP 超时 ' + method)) } }, timeout)
    })
  }

  async eval(expression, timeout = 40000) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeout)
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text
      throw new Error('页面执行失败: ' + String(d).slice(0, 300))
    }
    return r.result ? r.result.value : undefined
  }

  async navigate(url) {
    await this.send('Page.navigate', { url })
  }

  async cookies(url) {
    const r = await this.send('Network.getCookies', { urls: [url] })
    return r.cookies || []
  }

  async setCookie({ name, value, domain, path = '/', secure = true }) {
    await this.send('Network.setCookie', { name, value, domain, path, secure })
  }

  async close() {
    try { await this.send('Browser.close', {}, 3000) } catch {}
    try { this.ws && this.ws.close() } catch {}
    try { this.child && this.child.kill() } catch {}
    try { fs.rmSync(this.profile, { recursive: true, force: true }) } catch {}
  }
}
