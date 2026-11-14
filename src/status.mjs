// 把抢座结果写到一个 secret gist，供手机端轮询显示
//
// 设计约束：
//   · 内容不含学号/姓名，只有日期、座位、时段、状态
//   · token 只从本地文件读，绝不打印、不写进日志
//   · 任何失败都不影响抢座主流程（吞掉异常，只记一行）
import fs from 'node:fs'
import path from 'node:path'

const API = 'https://api.github.com'

function readToken(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * @param {object} cfg  { gistId, tokenFile, fileName }
 * @param {object} status  { date, ok, seat, start, end, message, at }
 * @param {(m:string)=>void} log
 */
export async function publishStatus(cfg, status, log = () => {}) {
  const { gistId, tokenFile, fileName = 'status.json' } = cfg || {}
  if (!gistId) { log('状态板未配置 gistId，跳过'); return false }
  const token = readToken(tokenFile)
  if (!token) { log('状态板：找不到 token 文件，跳过'); return false }

  const body = JSON.stringify({
    files: {
      [fileName]: { content: JSON.stringify(status, null, 2) },
    },
  })

  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(`${API}/gists/${gistId}`, {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'njfu-seat-runner',
          'content-type': 'application/json',
          'x-github-api-version': '2022-11-28',
        },
        body,
        signal: AbortSignal.timeout(15000),
      })
      if (r.ok) {
        log(`状态板已更新（第 ${i} 次尝试）`)
        return true
      }
      const t = await r.text()
      log(`状态板更新失败 HTTP ${r.status}: ${t.slice(0, 120)}`)
      if (r.status === 401 || r.status === 404) return false
    } catch (e) {
      log(`状态板更新异常（第 ${i} 次）：${e.message}`)
    }
    await new Promise((res) => setTimeout(res, 1500 * i))
  }
  return false
}

/** 供手机端参考的读取地址 */
export function rawUrl(gistId, fileName = 'status.json') {
  return `https://gist.githubusercontent.com/${gistId}/raw/${fileName}`
}
