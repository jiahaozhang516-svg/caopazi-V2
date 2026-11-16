// 抢座系统自检：本地配置 → 电源/任务 → 网络 → 真链路（瑞数 + CAS + 座位表）
// 结果推送到 Server酱，并写 logs/healthcheck-<日期>.log
//
// 用法:
//   node tools/healthcheck.mjs            # 完整自检
//   node tools/healthcheck.mjs --no-deep  # 跳过浏览器链路（快）
//   node tools/healthcheck.mjs --no-push  # 不推送（调试用）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { Browser, DESKTOP_UA } from '../src/browser.mjs'
import { createSeatClient } from '../src/libseat.mjs'
import { ensureOnline, isOnline } from '../src/portal.mjs'
import { pushAll } from '../src/notify.mjs'

const execFileAsync = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOG_DIR = path.join(ROOT, 'logs')
fs.mkdirSync(LOG_DIR, { recursive: true })

const argv = process.argv.slice(2)
const NO_DEEP = argv.includes('--no-deep')
const NO_PUSH = argv.includes('--no-push')
const HOST = 'https://libseat.njfu.edu.cn'

const CFG = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')) } catch { return {} } })()
const results = []
const notes = []

function log(m) { console.log(`[${new Date().toISOString()}] ${m}`) }
function add(name, ok, detail) {
  results.push({ name, ok, detail: String(detail || '').slice(0, 200) })
  log(`${ok ? '✅' : '⚠️'} ${name}${detail ? '：' + detail : ''}`)
}

async function ps(script, timeout = 20000) {
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script], { timeout })
  return String(stdout || '').trim()
}

/* ── 1. 配置 ─────────────────────────────────────────────────────────── */
function checkConfig() {
  const missing = []
  if (!CFG.user) missing.push('学号')
  if (!CFG.pass) missing.push('统一认证密码')
  if (CFG.portalEnabled && !CFG.portalPass) missing.push('门禁密码')
  if (!CFG.gistId) missing.push('gistId')
  add('配置完整', missing.length === 0, missing.length ? '缺 ' + missing.join('/') : `${CFG.user} · 区域 ${CFG.roomId}`)
}

/* ── 2. 计划任务 ─────────────────────────────────────────────────────── */
async function checkTasks() {
  for (const [task, label] of [['NJFU-Seat-Prewake', '预热任务'], ['NJFU-Seat-0700', '主任务']]) {
    try {
      const out = await ps(`
        $t = Get-ScheduledTask -TaskName '${task}' -ErrorAction SilentlyContinue
        if (-not $t) { 'MISSING'; exit }
        $i = Get-ScheduledTaskInfo -TaskName '${task}'
        "$($t.State)|$($t.Settings.WakeToRun)|$($i.NextRunTime.ToString('MM-dd HH:mm'))"
      `)
      const [state, wake, next] = out.split('|')
      const ok = state === 'Ready' && String(wake).toLowerCase() === 'true'
      add(label, ok, ok ? `下次 ${next}` : `状态 ${state}，唤醒 ${wake}`)
    } catch (e) { add(label, false, e.message.slice(0, 80)) }
  }
}

/* ── 3. 电源与时钟 ───────────────────────────────────────────────────── */
async function checkPower() {
  try {
    const out = await ps('powercfg /query SCHEME_CURRENT SUB_SLEEP RTCWAKE')
    const hex = (out.match(/0x[0-9a-fA-F]{8}/g) || []).slice(-2)
    const ok = hex.length === 2 && hex.every((h) => parseInt(h, 16) === 1)
    add('唤醒定时器', ok, ok ? 'AC/DC 均启用' : `AC=${hex[0]} DC=${hex[1]}`)
  } catch (e) { add('唤醒定时器', false, e.message.slice(0, 80)) }

  try {
    const out = await ps('powercfg /query SCHEME_CURRENT SUB_SLEEP HIBERNATEIDLE')
    const hex = (out.match(/0x[0-9a-fA-F]{8}/g) || []).slice(-2)
    const ok = parseInt(hex[1] || '1', 16) === 0
    add('电池不自动休眠', ok, ok ? 'DC 永不' : `DC=${hex[1]}`)
  } catch (e) { add('电池不自动休眠', false, e.message.slice(0, 80)) }

  const probes = []
  for (const url of ['https://www.baidu.com/', 'https://api.github.com/']) {
    try {
      const t0 = Date.now()
      const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) })
      const t1 = Date.now()
      const d = r.headers.get('date')
      if (!d) continue
      const server = new Date(d).getTime()
      // Date 头只精确到秒，取中点近似
      probes.push(Math.abs(server + (t1 - t0) / 2 + 500 - t1) / 1000)
    } catch {}
  }
  if (!probes.length) add('系统时钟', false, '拿不到网络时间')
  else {
    const skew = Math.min(...probes)
    add('系统时钟', skew < 5, `与网络时间相差约 ${skew.toFixed(1)}s`)
  }

  try {
    const out = await ps(`
      $b = Get-CimInstance Win32_Battery | Select-Object -First 1
      if ($b) { "$($b.BatteryStatus)|$($b.EstimatedChargeRemaining)" } else { 'NONE|0' }
    `, 25000)
    const [st, pct] = out.split('|')
    const onAc = st === '2'
    const ok = onAc || Number(pct) >= 40
    add('电量', ok, onAc ? '已接电源' : `${pct}%（电池供电）`)
  } catch { /* 台式机没有电池，忽略 */ }
}

/* ── 4. 网络 ─────────────────────────────────────────────────────────── */
function campusIp() {
  const prefix = CFG.campusPrefix || '10.14.'
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal && a.address.startsWith(prefix)) return a.address
  }
  return null
}

async function checkNetwork() {
  let ip = campusIp()
  if (!ip) {
    try {
      await execFileAsync('netsh', ['wlan', 'connect', `name=${CFG.wifiSsid || 'CMCC-EDU'}`, `ssid=${CFG.wifiSsid || 'CMCC-EDU'}`], { timeout: 15000 })
      for (let i = 0; i < 10 && !ip; i++) { await new Promise((r) => setTimeout(r, 2000)); ip = campusIp() }
    } catch {}
  }
  add('校园网 IP', Boolean(ip), ip || '未连接')

  const online = await isOnline()
  if (!online && CFG.portalEnabled) {
    try {
      const r = await ensureOnline({ portalIp: CFG.portalIp, portalUrl: CFG.portalUrl, user: CFG.portalUser, pass: CFG.portalPass, log })
      notes.push('门禁已自动重新认证（' + (r.via || '?') + '）')
      add('外网', true, '门禁认证后恢复')
      return
    } catch (e) { add('外网', false, '门禁认证失败'); return }
  }
  add('外网', online, online ? '204 正常' : '不通')
}

async function checkSite() {
  try {
    const r = await fetch(`${HOST}/ic-web/reserve.js?roomIds=${CFG.roomId}&resvDates=20260101&sysKind=8`, {
      headers: { 'user-agent': DESKTOP_UA }, signal: AbortSignal.timeout(10000),
    })
    const t = await r.text()
    const ok = /\{\s*"code"/.test(t)
    add('图书馆站点', ok, ok ? '可访问' : (t.includes('403') ? '403 非校园网' : 'HTTP ' + r.status))
    return ok
  } catch (e) { add('图书馆站点', false, e.message.slice(0, 80)); return false }
}

/* ── 5. 真链路：瑞数 + CAS + 座位表 ──────────────────────────────────── */
async function checkChain(date) {
  if (NO_DEEP) { notes.push('已跳过浏览器链路检查（--no-deep）'); return }
  const browser = new Browser()
  const t0 = Date.now()
  try {
    await browser.launch({ ua: DESKTOP_UA })
    await browser.navigate(HOST + '/')
    let p = null
    for (let i = 0; i < 60 && !p; i++) {
      await new Promise((r) => setTimeout(r, 300))
      const cs = await browser.cookies(HOST + '/')
      p = cs.find((c) => c.name.endsWith('P') && c.value.length > 100)
    }
    if (!p) { add('瑞数挑战', false, '30 秒没拿到 P cookie'); return }
    add('瑞数挑战', true, `P(${p.value.length})`)

    const cookies = Object.fromEntries((await browser.cookies(HOST + '/')).map((c) => [c.name, c.value]))
    const client = createSeatClient({ userAgent: DESKTOP_UA })
    client.adoptCookies(cookies)
    const info = await client.login(CFG.user, CFG.pass)
    add('CAS 登录', true, `成功 · ${Date.now() - t0}ms`)

    const seats = await client.seats(CFG.roomId, date.replace(/-/g, ''))
    const free = seats.filter((s) => !s.resvInfo || !s.resvInfo.length).length
    add('座位表', true, `共 ${seats.length} 个，空闲 ${free} 个`)

    // 目标座位是否还在候选里
    const names = seats.map((s) => s.devName)
    const want = (CFG.preferred || [])[0]
    if (want) add('首选座位存在', names.includes(want), want + (names.includes(want) ? '' : ' 不在座位表里'))
  } catch (e) {
    add('浏览器链路', false, e.message.slice(0, 120))
  } finally {
    try { await browser.close() } catch {}
  }
}

/* ── 6. 运行产物 ─────────────────────────────────────────────────────── */
function checkArtifacts(date) {
  const dry = fs.existsSync(path.join(ROOT, 'DRY'))
  add('DRY 模式', !dry, dry ? '存在 DRY 文件，会一直干跑！' : '关闭')

  const failed = path.join(LOG_DIR, 'FAILED.txt')
  const failedRecent = fs.existsSync(failed) && (Date.now() - fs.statSync(failed).mtimeMs) < 48 * 3600 * 1000
  add('近期无失败', !failedRecent, failedRecent ? '最近 48 小时有失败记录' : '干净')

  const mark = path.join(LOG_DIR, `booked-${date}.json`)
  const has = fs.existsSync(mark)
  add('目标日未预约', !has, has ? `${date} 已有标记（会跳过）` : `${date} 待抢`)

}

/* ── 主流程 ──────────────────────────────────────────────────────────── */
function cnDate(off) {
  const d = new Date(Date.now() + 8 * 3600 * 1000 + off * 86400 * 1000)
  return d.toISOString().slice(0, 10)
}

// 下一次 06:56 在今天是还是明天 → 抢的是那天的次日
function nextRunTarget() {
  const nowCn = new Date(Date.now() + 8 * 3600 * 1000)
  const minutes = nowCn.getUTCHours() * 60 + nowCn.getUTCMinutes()
  const daysToNextRun = minutes < (6 * 60 + 56) ? 0 : 1
  return cnDate(daysToNextRun + 1)
}

const date = nextRunTarget()
log(`自检开始，目标日期 ${date}`)
checkConfig()
await checkTasks()
await checkPower()
await checkNetwork()
const siteOk = await checkSite()
if (siteOk) await checkChain(date)
checkArtifacts(date)

const bad = results.filter((r) => !r.ok)
const okAll = bad.length === 0
const get = (n) => results.find((r) => r.name === n) || { detail: '' }
const pick = (n, re, dflt = '—') => (re.exec(get(n).detail) || [])[1] || dflt

// 本地日志：保留完整明细
const fullBody = results.map((r) => `${r.ok ? '✅' : '⚠️'} ${r.name}：${r.detail}`).join('\n') +
  (notes.length ? '\n' + notes.map((n) => '· ' + n).join('\n') : '')
const file = path.join(LOG_DIR, `healthcheck-${cnDate(0).replace(/-/g, '')}.log`)
fs.writeFileSync(file, `[${new Date().toISOString()}] ${okAll ? '正常' : '异常'}\n\n${fullBody}\n`, 'utf8')

// 推送：正常时只发三行摘要；异常时只列坏的那几项
let title, body
if (okAll) {
  title = '✅ 抢座自检 正常'
  body = [
    `任务 ${pick('预热任务', /(\d{2}:\d{2})/)} / ${pick('主任务', /(\d{2}:\d{2})/)}`,
    `网络 ${get('校园网 IP').detail} · 时钟 ${pick('系统时钟', /约 ([\d.]+)s/)}s`,
    `链路 瑞数✓ 登录✓ 座位 ${pick('座位表', /共 (\d+) 个/)}`,
    `目标 ${date.slice(5).replace('-', '/')} 待抢 · 电量 ${pick('电量', /(\d+%)/, '插电')}`,
  ].join('\n')
} else {
  title = `⚠️ 抢座自检 ${bad.length} 项异常`
  body = bad.map((r) => `${r.name}：${r.detail}`).join('\n') +
    (notes.length ? '\n' + notes.map((n) => '· ' + n).join('\n') : '') +
    `\n\n其余 ${results.length - bad.length} 项正常 · 目标 ${date.slice(5).replace('-', '/')}`
}

log('---- 汇总 ----')
log(title)
console.log(body)

if (!NO_PUSH) {
  try {
    const r = await pushAll({
      serverChanKeyFile: CFG.serverChanKeyFile,
      serverChan3KeyFile: CFG.serverChan3KeyFile,
      wecomWebhookFile: CFG.wecomWebhookFile,
      channels: CFG.notifyChannels,
      enabled: CFG.notifyEnabled !== false,
    }, { title, desp: body }, log)
    log('推送结果: ' + JSON.stringify(r))
  } catch (e) { log('推送失败: ' + e.message) }
}

setTimeout(() => process.exit(okAll ? 0 : 2), 800)
