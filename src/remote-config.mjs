// 远程配置：手机端写进 gist 的 remote-config.json，电脑每次运行前同步
//
// 注意：校园网对 gist.githubusercontent.com 的解析不稳定（Node 里会拿到 127.0.0.1），
// 所以优先走 GitHub API（api.github.com），raw 只作兜底。
//
// 只接受白名单字段，且逐项校验类型，避免手机端写坏配置导致抢座失败。
import fs from 'node:fs'

const ALLOWED = {
  bookingEnabled: (v) => typeof v === 'boolean',
  fireAt: (v) => typeof v === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(v),
  startTime: (v) => typeof v === 'string' && /^\d{2}:\d{2}$/.test(v),
  endTime: (v) => typeof v === 'string' && /^\d{2}:\d{2}$/.test(v),
  thursdayStart: (v) => typeof v === 'string' && /^\d{2}:\d{2}$/.test(v),
  fridayEnd: (v) => typeof v === 'string' && /^\d{2}:\d{2}$/.test(v),
  preferred: (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && /^[A-Za-z0-9-]{2,20}$/.test(x)),
  anchor: (v) => typeof v === 'string' && /^[A-Za-z0-9-]{2,20}$/.test(v),
  maxDistance: (v) => Number.isInteger(v) && v >= 0 && v <= 20,
  parity: (v) => v === 'even' || v === 'odd' || v === '',
  fallbackAny: (v) => typeof v === 'boolean',
  notifyEnabled: (v) => typeof v === 'boolean',
}

function sanitize(raw) {
  const out = {}
  const rejected = []
  for (const [k, v] of Object.entries(raw || {})) {
    if (!ALLOWED[k]) { rejected.push(k); continue }
    if (ALLOWED[k](v)) out[k] = v
    else rejected.push(k)
  }
  return { config: out, rejected }
}

function readToken(file) {
  try { return fs.readFileSync(file, 'utf8').trim() } catch { return '' }
}

async function viaApi({ gistId, tokenFile, fileName }) {
  const token = readToken(tokenFile)
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'njfu-seat-runner' }
  if (token) headers.authorization = `Bearer ${token}`
  const r = await fetch(`https://api.github.com/gists/${gistId}`, { headers, signal: AbortSignal.timeout(12000) })
  if (!r.ok) return null
  const j = await r.json()
  const f = j && j.files && j.files[fileName]
  if (!f) return null
  if (typeof f.content === 'string' && f.content) return f.content
  if (f.raw_url) {
    const rr = await fetch(f.raw_url, { signal: AbortSignal.timeout(12000) })
    if (rr.ok) return await rr.text()
  }
  return null
}

async function viaRaw({ gistId, fileName }) {
  const url = `https://gist.githubusercontent.com/${gistId}/raw/${fileName}?t=${Date.now()}`
  const r = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'cache-control': 'no-cache' } })
  if (!r.ok) return null
  return await r.text()
}

/**
 * @returns {Promise<object|null>} 合并用的局部配置；没有远程文件时返回 null
 */
export async function fetchRemoteConfig({ gistId, tokenFile, fileName = 'remote-config.json', log = () => {} }) {
  if (!gistId) return null
  let text = null
  try {
    text = await viaApi({ gistId, tokenFile, fileName })
  } catch (e) {
    log('远程配置 API 读取失败: ' + e.message.slice(0, 60))
  }
  if (!text) {
    try { text = await viaRaw({ gistId, fileName }) } catch (e) { /* 兜底也失败就算了 */ }
  }
  if (!text) { log('远程配置: 未取到（忽略，用本地配置）'); return null }
  try {
    const raw = JSON.parse(text)
    const { config, rejected } = sanitize(raw)
    if (rejected.length) log('远程配置忽略字段:', rejected.join(','))
    return Object.keys(config).length ? config : null
  } catch (e) {
    log('远程配置 JSON 解析失败（忽略）: ' + e.message.slice(0, 60))
    return null
  }
}
