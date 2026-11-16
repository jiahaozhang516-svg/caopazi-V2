// 结果推送：Server酱（微信）
//
// 配置：把 SendKey 放到 .secrets/serverchan.txt（一行，形如 SCTxxxxx）
// 免费额度：每天 5 条，足够"抢到/失败"各一条
// 文档：https://sct.ftqq.com/
import fs from 'node:fs'

const API = 'https://sctapi.ftqq.com'

function readKey(file) {
  try { return fs.readFileSync(file, 'utf8').trim() } catch { return '' }
}

/**
 * 根据 key 前缀决定接口：
 *   SCT…    → 经典 Server酱（微信服务号）  https://sctapi.ftqq.com/<key>.send
 *   sctp…   → Server酱³（App）             https://<uid>.push.ft07.com/send/<key>.send
 *              uid 从 key 里取：/^sctp(\d+)t/
 */
function endpointFor(key) {
  const m = /^sctp(\d+)t/i.exec(key)
  if (m) return `https://${m[1]}.push.ft07.com/send/${key}.send`
  return `${API}/${encodeURIComponent(key)}.send`
}

/**
 * @param {object} cfg  { sendKeyFile, enabled }
 * @param {object} msg  { title, desp }
 * @param {(m:string)=>void} log
 */
export async function pushServerChan(cfg, msg, log = () => {}) {
  const label = (cfg && cfg.label) || 'Server酱'
  if (cfg && cfg.enabled === false) { log(`${label} 推送已关闭，跳过`); return false }
  const key = readKey((cfg && cfg.sendKeyFile) || '.secrets/serverchan.txt')
  if (!key) { log(`${label} 未配置 SendKey，跳过`); return false }

  try {
    const r = await fetch(endpointFor(key), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ title: msg.title, desp: msg.desp || '' }).toString(),
      signal: AbortSignal.timeout(15000),
    })
    const t = await r.text()
    let j = null
    try { j = JSON.parse(t) } catch {}
    if (r.ok && j && (j.code === 0 || j.data || j.errno === 0)) {
      log(`${label} 推送已发送`)
      return true
    }
    log(`${label} 推送失败 HTTP ${r.status}: ${t.slice(0, 120)}`)
    return false
  } catch (e) {
    log(`${label} 推送异常: ` + e.message)
    return false
  }
}

/**
 * 企业微信群机器人（Webhook）
 * 不需要公网 IP、不需要可信 IP 白名单，配置只有一条 URL。
 * @param {object} cfg { webhookFile, enabled }
 */
export async function pushWecomWebhook(cfg, msg, log = () => {}) {
  if (cfg && cfg.enabled === false) { log('企业微信推送已关闭，跳过'); return false }
  const url = readKey((cfg && cfg.webhookFile) || '.secrets/wecom-webhook.txt')
  if (!url) { log('未配置企业微信 Webhook，跳过'); return false }

  // 群机器人 markdown 消息：标题加粗，正文换行
  const content = `**${msg.title}**\n${(msg.desp || '').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '[$1]($2)')}`
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
      signal: AbortSignal.timeout(15000),
    })
    const t = await r.text()
    let j = null
    try { j = JSON.parse(t) } catch {}
    if (r.ok && j && j.errcode === 0) {
      log('企业微信推送已发送')
      return true
    }
    log(`企业微信推送失败 HTTP ${r.status}: ${t.slice(0, 120)}`)
    return false
  } catch (e) {
    log('企业微信推送异常: ' + e.message)
    return false
  }
}

/** 同时尝试所有已配置的通道（互不影响） */
export async function pushAll(cfg, msg, log = () => {}) {
  const results = {}
  // channels 为空 = 所有已配置的通道都发；否则只发列表里的
  const ch = Array.isArray(cfg.channels) && cfg.channels.length ? cfg.channels : null
  const want = (name) => !ch || ch.includes(name)
  if (want('serverchan')) {
    try { results.serverchan = await pushServerChan({ sendKeyFile: cfg.serverChanKeyFile, enabled: cfg.enabled, label: 'Server酱(微信)' }, msg, log) } catch (e) { log('Server酱异常: ' + e.message) }
  }
  if (want('serverchan3')) {
    try { results.serverchan3 = await pushServerChan({ sendKeyFile: cfg.serverChan3KeyFile, enabled: cfg.enabled, label: 'Server酱3(App)' }, msg, log) } catch (e) { log('Server酱3异常: ' + e.message) }
  }
  if (want('wecom')) {
    try { results.wecom = await pushWecomWebhook({ webhookFile: cfg.wecomWebhookFile, enabled: cfg.enabled }, msg, log) } catch (e) { log('企业微信异常: ' + e.message) }
  }
  return results
}

/** 拼一条好读的推送内容 */
export function formatResult({ ok, date, seat, start, end, resvId, attempts, reason, gistId }) {
  const when = `${date} ${start || ''}${end ? '-' + end : ''}`.trim()
  if (ok) {
    return {
      title: `✅ 已抢到 ${seat}（${date}）`,
      desp: [
        `**座位**：${seat}`,
        `**时段**：${when}`,
        resvId ? `**预约号**：${resvId}` : '',
        `**用时**：${attempts ? attempts + ' 次尝试' : '一次成功'}`,
      ].filter(Boolean).join('\n\n'),
    }
  }
  return {
    title: `❌ 没抢到（${date}）`,
    desp: [
      `**日期**：${date}`,
      `**原因**：${reason || '未知'}`,
      `\n详细日志见电脑上 logs\\${String(date).replace(/-/g, '')}.log`,
    ].join('\n\n'),
  }
}
