// 07:00 抢座主程序：过瑞数 → CAS 登录 → 07:00 在浏览器页面里下单
//
// 用法:
//   node src/runner.mjs                 # 正常抢座（次日）
//   node src/runner.mjs --dry           # 干跑：只验证链路，不下真单
//   node src/runner.mjs --date 2026-11-16 --at 07:00:00
//
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Browser, DESKTOP_UA } from './browser.mjs'
import { createSeatClient } from './libseat.mjs'
import { ensureOnline, isOnline } from './portal.mjs'
import { publishStatus } from './status.mjs'

const ROOT = path.resolve('.')
const LOG_DIR = path.join(ROOT, 'logs')
fs.mkdirSync(LOG_DIR, { recursive: true })

const argv = process.argv.slice(2)
const arg = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const flag = (name) => argv.includes('--' + name)

const CFG = Object.assign(
  {
    user: '',
    pass: '',
    roomId: '100455352',
    roomName: '三层B区',
    preferred: ['3F-B004', '3F-B010', '3F-B002', '3F-B011'],
    anchor: '3F-B004',
    maxDistance: 3,
    parity: 'even',
    fallbackAny: false,
    startTime: '07:30',
    endTime: '22:00',
    thursdayStart: '10:00',
    fridayEnd: '20:00',
    // 校园网 Portal（Dr.COM）：没外网时先认证再干活
    wifiSsid: 'CMCC-EDU',
    campusPrefix: '10.14.',
    portalIp: '10.11.1.3',
    portalUrl: 'http://10.11.1.3:801/eportal/?c=ACSetting&a=Login&url=drappall',
    portalUser: '',
    portalPass: '',
    // 状态板（secret gist）：手机端轮询这里
    gistId: '',
    gistTokenFile: '.secrets/github-token.txt',
    fireAt: arg('at', '07:00:00'),
    maxAttempts: Number(arg('attempts', '90')),
    attemptGapMs: Number(arg('gap', '800')),
  },
  (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')) } catch { return {} } })(),
)

const DRY = flag('dry') || fs.existsSync(path.join(ROOT, 'DRY'))
const T0 = Date.now()
const stamp = () => new Date().toISOString()
const logLines = []
function log(...a) {
  const line = `[${stamp()}] ` + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  console.log(line)
  logLines.push(line)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function cnDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}
function weekdayCN(iso) {
  return new Date(iso + 'T12:00:00+08:00').getDay() // 0=周日
}

const HOST = 'https://libseat.njfu.edu.cn'

/* ── 1. 等网络 ─────────────────────────────────────────────────────────── */
const execFileAsync = promisify(execFile)

/** 本机是否已经拿到校园网 IP */
function campusIp() {
  const prefix = CFG.campusPrefix || '10.14.'
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && a.address.startsWith(prefix)) return a.address
    }
  }
  return null
}

/** 没连校园网时，用 netsh 自动连回保存的 Wi-Fi */
async function ensureWifi() {
  const ip = campusIp()
  if (ip) { log('校园网 IP:', ip); return true }
  const ssid = CFG.wifiSsid || 'CMCC-EDU'
  log(`没有校园网 IP，尝试连接 Wi-Fi「${ssid}」`)
  try {
    await execFileAsync('netsh', ['wlan', 'connect', `name=${ssid}`, `ssid=${ssid}`], { timeout: 20000 })
  } catch (e) {
    log('netsh 连接失败:', e.message.slice(0, 120))
  }
  for (let i = 0; i < 20; i++) {
    await sleep(2000)
    const got = campusIp()
    if (got) { log('Wi-Fi 已连接，IP:', got); return true }
  }
  log('40 秒内没拿到校园网 IP，继续等站点可达')
  return false
}

async function waitForCampusNetwork(maxMs = 8 * 60 * 1000) {
  // 先解决"链路层"：Wi-Fi 没连上就自己连
  await ensureWifi()

  // 再解决"认证层"：连上了但门禁没放行 → 自动登录
  if (CFG.portalEnabled && !(await isOnline())) {
    const r = await ensureOnline({
      portalIp: CFG.portalIp,
      portalUrl: CFG.portalUrl,
      user: CFG.portalUser,
      pass: CFG.portalPass,
      log,
    })
    log('Portal 认证结果:', r.ok ? '成功 via ' + r.via : '未成功')
  }

  const t0 = Date.now()
  let last = ''
  while (Date.now() - t0 < maxMs) {
    try {
      const r = await fetch(`${HOST}/ic-web/reserve.js?roomIds=${CFG.roomId}&resvDates=20260101&sysKind=8`, {
        headers: { 'user-agent': DESKTOP_UA },
        signal: AbortSignal.timeout(8000),
      })
      const t = await r.text()
      if (/\{\s*"code"/.test(t)) { log('网络就绪：站点可达（校园网）'); return true }
      last = t.includes('403') ? '403 非校园网' : 'HTTP ' + r.status
    } catch (e) {
      last = e.message.slice(0, 60)
    }
    log('等待网络… ' + last)
    await sleep(5000)
  }
  throw new Error('等待校园网超时：' + last)
}

/* ── 2. 拿瑞数 cookie ──────────────────────────────────────────────────── */
async function acquireWaf(browser) {
  await browser.navigate(HOST + '/')
  let p = null
  const t0 = Date.now()
  while (Date.now() - t0 < 30000) {
    await sleep(300)
    const cs = await browser.cookies(HOST + '/')
    const q = cs.find((c) => c.name.endsWith('P') && c.value.length > 100)
    if (q) { p = q; break }
  }
  if (!p) throw new Error('30 秒没拿到瑞数 P cookie')
  const all = await browser.cookies(HOST + '/')
  log('瑞数 cookie:', all.map((c) => `${c.name}(${c.value.length})`).join(' '))
  return Object.fromEntries(all.map((c) => [c.name, c.value]))
}

/* ── 3. 登录 ───────────────────────────────────────────────────────────── */
async function login(client, tries = 3) {
  let lastErr
  for (let i = 1; i <= tries; i++) {
    try {
      const t = Date.now()
      await client.login(CFG.user, CFG.pass)
      const info = await client.userInfo()
      log(`登录成功（第 ${i} 次，${Date.now() - t}ms）：${info.trueName || info.logonName} accNo=${info.accNo}`)
      return info
    } catch (e) {
      lastErr = e
      log(`登录第 ${i} 次失败：${e.message}`)
      await sleep(1200)
    }
  }
  throw new Error('登录失败：' + lastErr.message)
}

/* ── 4. 选座 ───────────────────────────────────────────────────────────── */
function parseCoord(s) {
  const [x, y] = String(s || '').split(',').map(Number)
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}
function seatNumber(name) {
  const m = /(\d+)\s*$/.exec(String(name || ''))
  return m ? Number(m[1]) : null
}
function isFree(seat) {
  const info = seat && seat.resvInfo
  if (!Array.isArray(info) || info.length === 0) return true
  return !info.some((r) => ((Number(r.resvStatus) || 0) & 128) === 0)
}

function planSeats(seats) {
  const byName = new Map(seats.map((s) => [String(s.devName), s]))
  const order = []
  for (const name of CFG.preferred) {
    const s = byName.get(name)
    if (s && isFree(s)) order.push({ seat: s, why: '目标 ' + name })
  }
  const anchor = byName.get(CFG.anchor) || byName.get(CFG.preferred[0])
  const ap = anchor ? parseCoord(anchor.coordinate) : null
  const anchorN = anchor ? seatNumber(anchor.devName) : null
  if (ap && anchorN !== null) {
    // 兜底：同排 + 座位号差 ≤ maxDistance + 尾数规则
    // （坐标单位里同排相邻只差 2.4，按坐标算"距离≤3"会退化成只剩自己）
    const near = seats
      .filter(isFree)
      .map((s) => {
        const p = parseCoord(s.coordinate)
        const n = seatNumber(s.devName)
        if (!p || n === null) return null
        return { s, n, sameRow: Math.abs(p.y - ap.y) <= 6, numDist: Math.abs(n - anchorN), dx: Math.abs(p.x - ap.x) }
      })
      .filter(Boolean)
      .filter((o) => o.sameRow && o.numDist <= Number(CFG.maxDistance || 3) && o.numDist > 0)
      .filter((o) => {
        if (CFG.parity === 'even') return o.n % 2 === 0
        if (CFG.parity === 'odd') return o.n % 2 === 1
        return true
      })
      .sort((a, b) => (a.numDist - b.numDist) || (a.dx - b.dx))
    for (const o of near) {
      if (!order.find((x) => x.seat.devId === o.s.devId)) {
        order.push({ seat: o.s, why: `同排就近 ${o.s.devName}（号差 ${o.numDist}）` })
      }
    }
  }
  if (CFG.fallbackAny) {
    for (const s of seats.filter(isFree)) {
      if (!order.find((x) => x.seat.devId === s.devId)) order.push({ seat: s, why: '兜底任意 ' + s.devName })
    }
  }
  return order
}

/* ── 5. 时段裁剪 ───────────────────────────────────────────────────────── */
function timeWindow(dateISO, seat) {
  const wd = weekdayCN(dateISO)
  let start = CFG.startTime
  let end = CFG.endTime
  if (wd === 4) start = CFG.thursdayStart > start ? CFG.thursdayStart : start // 周四 10:00 起
  if (wd === 5) end = CFG.fridayEnd < end ? CFG.fridayEnd : end // 周五 20:00 闭馆
  if (seat && seat.openStart && seat.openStart > start) start = seat.openStart
  if (seat && seat.openEnd && seat.openEnd < end) end = seat.openEnd
  return { start, end }
}

/* ── 6. 页面内下单 ─────────────────────────────────────────────────────── */
function bookInPage(browser, { date, start, end, devId, accNo, token }) {
  const payload = {
    sysKind: 8,
    appAccNo: accNo,
    memberKind: 1,
    resvMember: [accNo],
    resvBeginTime: `${date} ${start}:00`,
    resvEndTime: `${date} ${end}:00`,
    testName: '',
    captcha: '',
    resvProperty: 0,
    resvDev: [Number(devId)],
    memo: '',
  }
  // 注意：不能截断响应体再 parse——成功响应带 uuid/resvId，很容易超过 400 字符
  const expr = `fetch('/ic-web/reserve',{method:'POST',headers:{'content-type':'application/json','token':${JSON.stringify(token || '')}},body:${JSON.stringify(JSON.stringify(payload))}}).then(async r=>({status:r.status, body:await r.text()}))`
  return browser.eval(expr, 25000).then((o) => {
    const status = Number(o && o.status)
    const body = String((o && o.body) || '')
    let json = null
    try { json = JSON.parse(body) } catch {}
    return { status, body, json }
  })
}

/* ── 建会话：瑞数 cookie → CAS 登录 → 注入浏览器 ─────────────────────── */
async function prepareSession(browser) {
  const waf = await acquireWaf(browser)
  const client = createSeatClient({ userAgent: DESKTOP_UA })
  client.adoptCookies(waf)
  const info = await login(client)
  for (const [name, value] of Object.entries(client.snapshot().cookies)) {
    await browser.setCookie({ name, value, domain: 'libseat.njfu.edu.cn' })
  }
  await browser.navigate(HOST + '/')
  await sleep(1200)
  const title = await browser.eval('document.title')
  log('浏览器内部登录态页面:', JSON.stringify(title))
  return { client, info }
}

/* ── 主流程 ────────────────────────────────────────────────────────────── */
async function main() {
  const date = arg('date', cnDate(1))
  log(`目标日期 ${date}（周${'日一二三四五六'[weekdayCN(date)]}）${DRY ? ' [干跑]' : ''}`)

  // 幂等：已经订上就直接退出（供 07:05 补跑用）
  const mark = path.join(LOG_DIR, `booked-${date}.json`)
  if (!DRY && fs.existsSync(mark)) {
    const prev = (() => { try { return JSON.parse(fs.readFileSync(mark, 'utf8')) } catch { return {} } })()
    log('该日期已标记为预约成功，跳过：' + JSON.stringify(prev).slice(0, 200))
    await publishStatus({ gistId: CFG.gistId, tokenFile: CFG.gistTokenFile }, {
      date, ok: true, seat: prev.seat || null, start: prev.start || null, end: prev.end || null,
      message: '已有预约（跳过重复下单）', at: new Date().toISOString(),
    }, log)
    return { ok: true, date, skipped: true }
  }

  await waitForCampusNetwork()

  // 先把开抢时刻算出来：cookie 越新越好，所以尽量晚才算/登录
  const [hh, mm, ss] = CFG.fireAt.split(':').map(Number)
  const fireAt = new Date(`${date}T00:00:00+08:00`)
  fireAt.setDate(fireAt.getDate() - 1) // 前一天 07:00 抢次日
  fireAt.setHours(hh, mm, ss || 0, 0)
  const lead = Number(CFG.prepareLeadSec || 30) * 1000
  const prepareAt = fireAt.getTime() - lead
  const now = Date.now()
  if (now < prepareAt - 1000) {
    log(`距开抢 ${((fireAt - now) / 1000).toFixed(1)}s，先睡到开抢前 ${lead / 1000}s`)
    await sleep(prepareAt - now)
  }
  log(`开始准备（距开抢 ${((fireAt.getTime() - Date.now()) / 1000).toFixed(1)}s）`)

  const browser = new Browser()
  let client = null
  try {
    await browser.launch({ ua: DESKTOP_UA })
    let info
    ;({ client, info } = await prepareSession(browser))

    // 座位表 + 选座
    const compact = date.replace(/-/g, '')
    let seats = await client.seats(CFG.roomId, compact)
    log(`座位表 ${seats.length} 个，空闲 ${seats.filter(isFree).length} 个`)
    let plan = planSeats(seats)
    log('候选顺序:', plan.map((p) => p.seat.devName).join(' > ') || '(空)')

    const { start, end } = timeWindow(date, plan[0] && plan[0].seat)
    log(`时段 ${date} ${start} - ${end}`)

    // 对齐到开抢时刻
    const wait = fireAt.getTime() - Date.now()
    log(`距开抢 ${(wait / 1000).toFixed(1)}s`)
    if (wait > 0) {
      if (wait > 20000) {
        await sleep(wait - 15000)
        // 临开抢前刷新一次座位表
        seats = await client.seats(CFG.roomId, compact)
        plan = planSeats(seats)
        log(`临抢座位表：空闲 ${seats.filter(isFree).length}，候选 ${plan.map((p) => p.seat.devName).join('>') || '(空)'}`)
      }
      while (Date.now() < fireAt.getTime() - 60) await sleep(20)
    }

    if (DRY) {
      // 用过去日期验证下单链路，不会产生真实预约
      const probe = await bookInPage(browser, {
        date: '2020-01-01', start, end,
        devId: plan[0] ? plan[0].seat.devId : 1,
        accNo: info.accNo, token: info.token,
      })
      log('干跑下单探针:', probe.status, probe.body.slice(0, 160))
      return { ok: probe.status === 200, dry: true, probe }
    }

    // 抢座循环
    let ok = null
    let attempt = 0
    let seatIdx = 0
    let timeErrs = 0
    const tStart = Date.now()
    while (attempt < CFG.maxAttempts && Date.now() - tStart < 90000) {
      if (!plan.length) {
        // 没有候选就重新拉一次
        seats = await client.seats(CFG.roomId, compact)
        plan = planSeats(seats)
        if (!plan.length) { await sleep(600); continue }
      }
      const pick = plan[Math.min(seatIdx, plan.length - 1)]
      const w = timeWindow(date, pick.seat)
      const r = await bookInPage(browser, { date, start: w.start, end: w.end, devId: pick.seat.devId, accNo: info.accNo, token: info.token })
      attempt++
      const msg = r.json ? r.json.message : r.body.slice(0, 80)
      log(`#${attempt} ${pick.seat.devName} ${w.start}-${w.end} → ${r.status} ${msg}`)
      // 双保险：JSON 解析成功看 code，解析异常时用文本兜底
      const success = (r.json && r.json.code === 0) || (!r.json && /"code"\s*:\s*0/.test(r.body) && /新增成功|预约成功/.test(r.body))
      if (success) {
        ok = {
          seat: pick.seat.devName, devId: pick.seat.devId, start: w.start, end: w.end,
          uuid: r.json && r.json.data ? r.json.data.uuid : null,
          resvId: r.json && r.json.data ? r.json.data.resvId : null,
          raw: r.json || r.body.slice(0, 500),
        }
        break
      }
      if (r.status === 412) {
        log('   → 被瑞数再次挑战（412），重建会话')
        try {
          ;({ client, info } = await prepareSession(browser))
          seats = await client.seats(CFG.roomId, compact)
          plan = planSeats(seats)
          seatIdx = 0
          log('   会话已重建，候选:', plan.map((p) => p.seat.devName).join('>') || '(空)')
        } catch (e) {
          log('   重建失败：' + e.message)
        }
        continue
      }
      // 错误分类：占座才换座位；时间/频繁只退避重试
      const occupied = /已被|占用|不可用|冲突|座位已|预约失败|设备/.test(msg) && !/时间/.test(msg)
      const busy = /频繁/.test(msg)
      // 实测：服务端窗口在 07:00:05 左右才真正打开，之前一律回"请在07:00后开始预约"
      const timeErr = /时间范围|当前时间|未到|开放时间|开始预约/.test(msg)
      if (occupied) {
        seatIdx = Math.min(seatIdx + 1, plan.length - 1)
        log('   → 换下一个候选座位')
        if (seatIdx >= plan.length - 1) {
          seats = await client.seats(CFG.roomId, compact)
          const fresh = planSeats(seats)
          if (fresh.length) { plan = fresh; seatIdx = 0 }
        }
      }
      // 节奏：前三发快（0.8s），第 4 发前停 2.5s 让限流计数回落，循环往复
      let gap = CFG.attemptGapMs
      if (busy) gap = Math.max(gap, 2200)
      if (timeErr) {
        timeErrs += 1
        gap = timeErrs % 4 === 0 ? 2500 : 800
      }
      const elapsed = ((Date.now() - fireAt.getTime()) / 1000).toFixed(1)
      log(`   ↳ 第 ${elapsed}s，间隔 ${gap}ms`)
      await sleep(gap)
    }

    if (ok) {
      log(`✅ 预约成功：${ok.seat} ${date} ${ok.start}-${ok.end}`, ok.raw)
      try { fs.writeFileSync(mark, JSON.stringify({ date, ...ok, at: stamp() }, null, 2)) } catch {}
    } else {
      log('❌ 未成功（尝试 ' + attempt + ' 次）')
    }
    // 写状态板（失败不影响主流程）
    await publishStatus({ gistId: CFG.gistId, tokenFile: CFG.gistTokenFile }, {
      date,
      ok: Boolean(ok),
      seat: ok ? ok.seat : null,
      start: ok ? ok.start : null,
      end: ok ? ok.end : null,
      message: ok ? '新增成功' : `未成功（${attempt} 次尝试）`,
      at: new Date().toISOString(),
    }, log)
    return { ok: Boolean(ok), date, result: ok }
  } finally {
    try { await browser.close() } catch {}
    const file = path.join(LOG_DIR, `${date.replace(/-/g, '')}${DRY ? '-dry' : ''}.log`)
    fs.writeFileSync(file, logLines.join('\n') + '\n')
    fs.writeFileSync(path.join(LOG_DIR, 'last-run.json'), JSON.stringify({
      at: stamp(), date, dry: DRY, ms: Date.now() - T0,
    }, null, 2))
  }
}

main()
  .then((r) => { console.log('RESULT ' + JSON.stringify({ ok: r && r.ok, date: r && r.date })); process.exit(r && r.ok ? 0 : 3) })
  .catch(async (e) => {
    log('fatal: ' + e.message)
    console.error(e.stack)
    try {
      await publishStatus({ gistId: CFG.gistId, tokenFile: CFG.gistTokenFile }, {
        date: cnDate(1), ok: false, seat: null, start: null, end: null,
        message: '运行失败：' + String(e.message).slice(0, 80),
        at: new Date().toISOString(),
      }, log)
    } catch {}
    process.exit(1)
  })
