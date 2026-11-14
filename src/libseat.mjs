/**
 * libseat.js —— 南林图书馆座位预约（libseat.njfu.edu.cn/ic-web）客户端
 *
 * 协议要点（2026-11-02 真机实测，全部字段来自前端源码）：
 *   1. 登录：GET /login/publicKey → {publicKey, nonceStr}
 *            POST /login/user {logonName, password: RSA(密码 + ";" + nonceStr), captcha:"", consoleType:"4"}
 *            → {token, accNo, ...}
 *   2. 之后所有请求带 header `token: <token>` 和 `lan: 1`，以及登录下发的 cookie（ic-cookie）。
 *   3. 座位图：GET /reserve?roomIds=<区域id>&resvDates=YYYYMMDD&sysKind=8
 *            → [{devId, devName, coordinate, resvInfo:[...]}, ...]
 *   4. 下单：POST /reserve/seat
 *        {sysKind:8, appAccNo, memberKind:1, resvMember:[accNo],
 *         resvBeginTime:"YYYY-MM-DD HH:mm:00", resvEndTime:"…",
 *         resvDev:[0], encryptVlaue: RSA(随机16位串),
 *         resvDevEncrypts:[ AES-128-CBC(str(devId), key=随机串, iv="ABCDEF1234123412", ZeroPadding).hex().upper() ],
 *         memo:"", testName:"", captcha:"", resvProperty:0}
 *   5. 取消：POST /reserve/delete {uuid, resvId} → "删除成功"
 *
 * 站点有反爬：短时间十几次请求后整站返回 403 HTML 数分钟，所以这里所有请求串行、带间隔。
 */

import crypto from 'node:crypto'

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 Edg/144.0.0.0'

const BASE = 'https://libseat.njfu.edu.cn/ic-web'
const AES_IV = Buffer.from('ABCDEF1234123412', 'utf8')
const NONCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** 睡眠，用于给请求之间留间隔（反爬）。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 16 位随机串（前端 E(16) 的等价实现）。 */
export function randomNonce(len = 16) {
  let out = ''
  for (let i = 0; i < len; i += 1) out += NONCE_CHARS.charAt(Math.floor(Math.random() * NONCE_CHARS.length))
  return out
}

/** 伪 UUID（浏览器端 ic-cookie 的形态：8-4-4-4-12 十六进制）。 */
function randomUuid() {
  const hex = '0123456789abcdef'
  const seg = (n) => {
    let s = ''
    for (let i = 0; i < n; i += 1) s += hex.charAt(Math.floor(Math.random() * 16))
    return s
  }
  return seg(8) + '-' + seg(4) + '-4' + seg(3) + '-a' + seg(3) + '-' + seg(12)
}

/** 把 SPKI base64 公钥包成 PEM。 */
function toPem(b64) {
  const body = String(b64 || '').replace(/\s+/g, '').match(/.{1,64}/g)
  return '-----BEGIN PUBLIC KEY-----\n' + (body ? body.join('\n') : '') + '\n-----END PUBLIC KEY-----\n'
}

/** RSA / PKCS#1 v1.5 加密（前端 JSEncrypt 的等价实现）。 */
export function rsaEncrypt(publicKeyB64, text) {
  return crypto
    .publicEncrypt({ key: toPem(publicKeyB64), padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(text, 'utf8'))
    .toString('base64')
}

/**
 * 统一身份认证（uia.njfu.edu.cn/authserver）的密码加密。
 * 它用的是前端 security.js 里那套「教科书式 RSA」：
 *   · 没有 PKCS#1 填充
 *   · 明文按 **小端 16 位字** 装进 BigInt（digit[j] = b[2j] + (b[2j+1]<<8)）
 *   · 明文先零填充到 chunkSize = 2*(位数-1) = 126 字节
 *   · 结果输出 256 位十六进制
 * 用常规 PKCS#1 会得到「账号或密码错误」，这是踩过的坑。
 */
const CAS_MODULUS =
  '8aed7e057fe8f14c73550b0e6467b023616ddc8fa91846d2613cdb7f7621e3cada4cd5d812d627af6b87727ade4e26d26208b7326815941492b2204c3167ab2d53df1e3a2c9153bdb7c8c2e968df97a5e7e01cc410f92c4c2c2fba529b3ee988ebc1fca99ff5119e036d732c368acf8beba01aa2fdafa45b21e4de4928d0d403'
const CAS_N = BigInt('0x' + CAS_MODULUS)
const CAS_E = BigInt(65537)
const CAS_ONE = BigInt(1)
const CAS_ZERO = BigInt(0)
const CAS_CHUNK = 2 * (Math.floor((CAS_N.toString(2).length + 15) / 16) - 1)

function modPow(base, exp, mod) {
  let result = CAS_ONE
  let b = base % mod
  let e = exp
  while (e > CAS_ZERO) {
    if (e & CAS_ONE) result = (result * b) % mod
    b = (b * b) % mod
    e >>= CAS_ONE
  }
  return result
}

export function casEncrypt(password) {
  const bytes = []
  for (const ch of String(password)) bytes.push(ch.charCodeAt(0) & 0xff)
  while (bytes.length % CAS_CHUNK !== 0) bytes.push(0)
  let m = CAS_ZERO
  for (let j = 0; j < bytes.length; j += 2) {
    const word = BigInt(bytes[j] + ((j + 1 < bytes.length ? bytes[j + 1] : 0) << 8))
    m |= word << BigInt(16 * (j / 2))
  }
  return modPow(m, CAS_E, CAS_N).toString(16).padStart(256, '0')
}

/** AES-128-CBC + ZeroPadding + 大写 HEX（前端 j(devId, nonce) 的等价实现）。 */
export function aesSeal(plainText, keyText) {
  const key = Buffer.from(String(keyText), 'utf8')
  if (key.length !== 16) throw new Error('AES key 必须是 16 字节')
  const raw = Buffer.from(String(plainText), 'utf8')
  const padLen = (16 - (raw.length % 16)) % 16
  const data = Buffer.concat([raw, Buffer.alloc(padLen)])
  const cipher = crypto.createCipheriv('aes-128-cbc', key, AES_IV)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(data), cipher.final()]).toString('hex').toUpperCase()
}

/** 东八区当天 / 明天的日期串。 */
export function dateInCN(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000)
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return fmt.format(d) // YYYY-MM-DD
}

/** YYYY-MM-DD → YYYYMMDD */
export function compactDate(isoDate) {
  return String(isoDate).replace(/-/g, '')
}

/* ── 选座策略 ─────────────────────────────────────────────────────────── */

function parseCoord(text) {
  const m = String(text || '').split(',')
  if (m.length !== 2) return null
  const x = Number(m[0])
  const y = Number(m[1])
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

function seatNumber(name) {
  const m = /(\d+)\s*$/.exec(String(name || ''))
  return m ? Number(m[1]) : null
}

function isFree(seat) {
  const info = seat && seat.resvInfo
  if (!Array.isArray(info) || info.length === 0) return true
  // 有未结束（非 128 位）的预约即视为占用
  return !info.some((r) => ((Number(r.resvStatus) || 0) & 128) === 0)
}

/**
 * 按偏好挑座：目标列表 → 就近 + 尾数规则 → 任意。
 * @returns {{seat: object|null, reason: string, detail: string}}
 */
export function pickSeat(seats, prefs) {
  const list = Array.isArray(seats) ? seats : []
  const preferred = Array.isArray(prefs.preferred) ? prefs.preferred.map(String) : []
  const free = list.filter(isFree)
  const byName = new Map(list.map((s) => [String(s.devName), s]))

  for (const name of preferred) {
    const seat = byName.get(name)
    if (seat && isFree(seat)) return { seat, reason: 'target', detail: '目标座位 ' + name + ' 空闲' }
  }

  const anchor = byName.get(preferred[0] || '') || null
  const anchorPos = anchor ? parseCoord(anchor.coordinate) : null
  const maxDistance = Number(prefs.maxDistance) > 0 ? Number(prefs.maxDistance) : 99
  const parity = String(prefs.parity || '').toLowerCase()

  if (anchorPos) {
    const candidates = free
      .map((seat) => {
        const pos = parseCoord(seat.coordinate)
        if (!pos) return null
        const dist = Math.abs(pos.x - anchorPos.x) + Math.abs(pos.y - anchorPos.y)
        return { seat, dist }
      })
      .filter((entry) => entry !== null)
      .filter((entry) => {
        if (parity === 'even' || parity === 'odd') {
          const n = seatNumber(entry.seat.devName)
          if (n === null) return false
          if (parity === 'even' && n % 2 !== 0) return false
          if (parity === 'odd' && n % 2 !== 1) return false
        }
        return true
      })
      .sort((a, b) => a.dist - b.dist)

    if (candidates.length > 0 && candidates[0].dist <= maxDistance) {
      const best = candidates[0]
      return {
        seat: best.seat,
        reason: 'nearby',
        detail:
          '目标都被占，选最近的 ' + best.seat.devName + '（离 ' + (preferred[0] || '锚点') + ' 距离 ' + best.dist.toFixed(1) + '）',
      }
    }
  }

  if (prefs.fallbackAny === true && free.length > 0) {
    const any = free[0]
    return { seat: any, reason: 'any', detail: '没有符合规则的座位，退而取 ' + any.devName }
  }

  return { seat: null, reason: 'none', detail: '没有可用座位' }
}

/* ── 客户端 ───────────────────────────────────────────────────────────── */

export function createSeatClient(options) {
  const ua = options.userAgent || DEFAULT_UA
  const state = { token: '', cookies: {}, accNo: 0, user: '' }
  /** 公钥缓存：抢座窗口内每 20 秒重试一次，不能每次都去要公钥。 */
  let pkCache = { key: '', at: 0 }

  async function publicKey() {
    if (pkCache.key && Date.now() - pkCache.at < 10 * 60 * 1000) return pkCache.key
    const res = await call('/login/publicKey')
    const pk = (res && res.data) || {}
    if (!pk.publicKey) throw new Error('下单前拿不到公钥')
    pkCache = { key: pk.publicKey, at: Date.now() }
    return pkCache.key
  }

  function cookieHeader() {
    return Object.entries(state.cookies)
      .filter(([, v]) => v !== '')
      .map(([k, v]) => k + '=' + v)
      .join('; ')
  }

  function absorb(res) {
    let list = []
    try {
      list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    } catch (_e) {}
    for (const line of list) {
      const first = String(line).split(';')[0]
      const eq = first.indexOf('=')
      if (eq > 0) state.cookies[first.slice(0, eq).trim()] = first.slice(eq + 1).trim()
    }
  }

  function headers(extra) {
    const h = {
      'user-agent': ua,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      referer: 'https://libseat.njfu.edu.cn/',
      origin: 'https://libseat.njfu.edu.cn',
      lan: '1',
    }
    const cookie = cookieHeader()
    if (cookie) h.cookie = cookie
    if (state.token) h.token = state.token
    return Object.assign(h, extra || {})
  }

  /**
   * 2026-11-13 起站点上了瑞数 WAF：非浏览器客户端请求动态路径一律 412 挑战页。
   * 实测只要路径带静态资源后缀（.js/.json/.css/.png…），WAF 就放行，
   * 而 Spring 会忽略后缀照常路由到同一个接口。
   * 因此：先按原路径请求；被挑战（返回非 JSON）时，自动补 .js 再试一次。
   */
  function withStaticSuffix(path) {
    const q = path.indexOf('?')
    const p = q >= 0 ? path.slice(0, q) : path
    const rest = q >= 0 ? path.slice(q) : ''
    if (/\.(js|json|css|png|ico|txt|xml|map|svg|woff|ttf|eot)$/i.test(p)) return path
    return p + '.js' + rest
  }

  async function callOnce(path, init) {
    const url = BASE + path
    const res = await fetch(url, {
      method: (init && init.method) || 'GET',
      headers: headers(init && init.headers),
      body: init && init.body,
      signal: AbortSignal.timeout(35000),
    })
    absorb(res)
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch (_e) {}
    return { json, status: res.status }
  }

  async function call(path, init) {
    const first = await callOnce(path, init)
    if (first.json) return first.json
    // 被 WAF 拦了（挑战页/403/412），用静态后缀绕一次
    const alt = withStaticSuffix(path)
    if (alt !== path) {
      const second = await callOnce(alt, init)
      if (second.json) return second.json
      throw new Error(
        '座位系统返回了非 JSON（HTTP ' + second.status + '，加了 .js 后缀仍然被拦），可能触发反爬，稍后再试',
      )
    }
    throw new Error('座位系统返回了非 JSON（HTTP ' + first.status + '），可能触发反爬，稍后再试')
  }

  /**
   * 登录（2026-11-12 实测）：站点已切到 CAS 单点登录，密码登录接口停用。
   * 真正可用的自动化链路（全自动、无需人工）：
   *   ① GET /ic-web/auth/address?finalAddress=…&manager=false → 服务端签发 uuid 并给出登录地址
   *   ② 跟随该地址 → 302 到 uia.njfu.edu.cn/authserver/login?service=…
   *   ③ 取 CAS 登录页，抽出 execution
   *   ④ RSA 加密密码（无填充 + 小端 16 位字序，见 casEncrypt）后 POST
   *   ⑤ CAS 返回的 doAuth 页面里写着 window.location.href='…/auth/token?uuid=…&uniToken=…'
   *   ⑥ GET 它 → 302 + Set-Cookie: ic-cookie ← 之后所有接口靠这个 cookie
   */
  async function login(user, pass) {
    const HOST_LIB = 'libseat.njfu.edu.cn'
    const HOST_CAS = 'uia.njfu.edu.cn'
    // 瑞数 WAF 的 O/P cookie 必须带进整条登录链，否则 /authcenter/... 一样会被 412。
    const jar = { [HOST_LIB]: Object.assign({}, state.cookies), [HOST_CAS]: {} }
    const cookieOf = (host) =>
      Object.entries(jar[host] || {})
        .map(([k, v]) => k + '=' + v)
        .join('; ')
    const absorbInto = (host, res) => {
      let list = []
      try {
        list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
      } catch (_e) {}
      for (const line of list) {
        const first = String(line).split(';')[0]
        const eq = first.indexOf('=')
        if (eq > 0) jar[host][first.slice(0, eq).trim()] = first.slice(eq + 1).trim()
      }
    }
    /**
     * 手动跟随重定向、按 host 取 cookie。
     * 必须手动：CAS 提交成功后 302 回 libseat，若让 fetch 自动跟随，
     * 带过去的是 CAS 的 cookie，WAF cookie 丢了 → 412。
     */
    const follow = async (url0, opts0) => {
      let url = url0
      let method = (opts0 && opts0.method) || 'GET'
      let body = opts0 && opts0.body
      const extra = Object.assign({}, (opts0 && opts0.headers) || {})
      let prevHost = new URL(url).host
      for (let hop = 0; hop < 10; hop++) {
        const host = new URL(url).host
        if (host !== prevHost) {
          // 跨站跳转后，CAS 的 referer/origin 不能再带
          delete extra.referer
          delete extra.origin
          prevHost = host
        }
        const headers = Object.assign({ 'user-agent': ua, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }, extra)
        const ck = cookieOf(host)
        if (ck) headers.cookie = ck
        const res = await fetch(url, { method, body, headers, redirect: 'manual', signal: AbortSignal.timeout(35000) })
        absorbInto(host, res)
        const loc = res.headers.get('location')
        if (res.status >= 300 && res.status < 400 && loc) {
          url = new URL(loc, url).href
          if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET')) {
            method = 'GET'
            body = undefined
            delete extra['content-type']
          }
          continue
        }
        return res
      }
      throw new Error('重定向次数过多')
    }

    // ① 取登录地址（服务端现场签发 uuid，不能自己编）
    const addr = await call('/auth/address?finalAddress=' + encodeURIComponent('https://' + HOST_LIB) + '&manager=false')
    if (!addr || addr.code !== 0 || !addr.data) throw new Error('取登录地址失败：' + ((addr && addr.message) || '未知'))
    // ② 跟着它跳到 CAS 登录页
    let res = await follow(addr.data)
    // ③ 抽 execution
    const html = await res.text()
    const ex = /name="execution"\s+value="([^"]+)"/.exec(html)
    if (!ex) throw new Error('CAS 页面里没有 execution（HTTP ' + res.status + '）')
    // ④ 提交账号密码
    await sleep(300)
    const form = new URLSearchParams({
      username: String(user),
      password: casEncrypt(String(pass)),
      encrypted: 'true',
      execution: ex[1],
      _eventId: 'submit',
      loginType: '1',
      rememberMe: 'true',
    })
    const casUrl = res.url || String(addr.data)
    res = await follow(casUrl, {
      method: 'POST',
      body: form,
      headers: { 'content-type': 'application/x-www-form-urlencoded', referer: casUrl, origin: 'https://' + HOST_CAS },
    })
    const page = await res.text()
    // ⑤ 正常跟完就应拿到 ic-cookie；没拿到时再看 doAuth 页面里的跳转地址补一刀
    if (!jar[HOST_LIB]['ic-cookie']) {
      const jump = /window\.location\.href\s*=\s*'([^']+)'/.exec(page)
      if (!jump) {
        if (page.indexOf('账号或密码错误') >= 0) throw new Error('登录失败：账号或密码不正确')
        const brief = page.replace(/\s+/g, ' ').slice(0, 160)
        throw new Error('CAS 登录后没有拿到 ic-cookie（HTTP ' + res.status + '）：' + brief)
      }
      await follow(jump[1])
    }
    const cookie = jar[HOST_LIB]['ic-cookie']
    if (!cookie) throw new Error('没能换到 ic-cookie')
    state.cookies['ic-cookie'] = cookie
    state.cookies['rememberMe'] = 'deleteMe'
    state.user = String(user)
    return { accNo: state.accNo, name: '', dept: '' }
  }

  async function seats(roomId, dateCompact) {
    const query = '?roomIds=' + encodeURIComponent(roomId) + '&resvDates=' + encodeURIComponent(dateCompact) + '&sysKind=8'
    const res = await call('/reserve' + query)
    if (!res || res.code !== 0) throw new Error('读取座位表失败：' + ((res && res.message) || '未知'))
    return Array.isArray(res.data) ? res.data : []
  }

  /** 当前登录用户（accNo 必须从服务端取，不能猜）。 */
  async function userInfo() {
    const res = await call('/auth/userInfo')
    if (!res || res.code !== 0) throw new Error('读取用户信息失败：' + ((res && res.message) || '未知'))
    const d = res.data || {}
    if (d.accNo) state.accNo = Number(d.accNo)
    if (d.logonName) state.user = d.logonName
    return d
  }

  /** 每周的开放时段：[{dayOfWeek:0-6, firstTime:["07:30","22:00"]}]。 */
  async function openScope(roomId) {
    const res = await call('/seatRoom/openScope?roomId=' + encodeURIComponent(roomId))
    if (!res || res.code !== 0) return []
    return Array.isArray(res.data) ? res.data : []
  }

  async function book(input) {
    // 2026-11 版前端的载荷（见 js/chunk-1c93f754.js 等）：
    // 已经没有 encryptVlaue / resvDevEncrypts，也不再取 publicKey。
    const body = JSON.stringify({
      sysKind: 8,
      appAccNo: state.accNo,
      memberKind: 1,
      resvMember: [state.accNo],
      resvBeginTime: input.date + ' ' + input.start + ':00',
      resvEndTime: input.date + ' ' + input.end + ':00',
      testName: '',
      captcha: '',
      resvProperty: 0,
      resvDev: [Number(input.devId) || 0],
      memo: '',
    })
    await sleep(120)
    const res = await call('/reserve/seat', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    return {
      ok: !!(res && res.code === 0),
      message: (res && res.message) || '未知',
      resvId: res && res.data ? res.data.resvId : null,
      uuid: res && res.data ? res.data.uuid : null,
      raw: res,
    }
  }

  async function cancel(uuid, resvId) {
    const body = JSON.stringify({ uuid, resvId })
    const res = await call('/reserve/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    return { ok: !!(res && res.code === 0), message: (res && res.message) || '未知' }
  }

  /**
   * 站点改成 CAS 单点登录后，密码登录已停用。
   * 实测认证凭证就是 `ic-cookie` 这一个 cookie（浏览器登录后由服务端下发，HttpOnly）：
   *   Cookie: ic-cookie=<uuid>  →  读写接口全部可用，不需要 token。
   * 所以只要手里有 ic-cookie 就算「已登录」，不必走密码登录。
   */
  function hasSession() {
    return Boolean(state.token) || Boolean(state.cookies && state.cookies['ic-cookie'])
  }

  function snapshot() {
    return { token: state.token, cookies: state.cookies, accNo: state.accNo, user: state.user }
  }

  function restore(saved) {
    if (!saved || typeof saved !== 'object') return
    state.token = String(saved.token || '')
    state.cookies = Object.assign({}, saved.cookies || {})
    state.accNo = Number(saved.accNo) || 0
    state.user = String(saved.user || '')
  }

  /**
   * 用一条完整的 Cookie 请求头恢复会话（含瑞数 WAF 的 O/P 两个 cookie）。
   * 用途：外部（浏览器 / 补环境进程）刷新好 cookie 后写文件，插件直接接管，
   * 不去碰被 WAF 挡住的登录入口。
   */
  function restoreCookieHeader(header) {
    const text = String(header || '').replace(/^\s*cookie\s*:\s*/i, '').trim()
    if (!text) return false
    const jar = {}
    for (const part of text.split(';')) {
      const seg = part.trim()
      const eq = seg.indexOf('=')
      if (eq > 0) jar[seg.slice(0, eq).trim()] = seg.slice(eq + 1).trim()
    }
    if (!jar['ic-cookie']) return false
    state.cookies = jar
    return true
  }

  /**
   * 注入浏览器算出来的瑞数 WAF cookie（O/P 等）。登录前必须先有，
   * 否则连 /ic-web/auth/address 都会被 412 挡住。
   */
  function adoptCookies(map) {
    if (!map || typeof map !== 'object') return false
    let n = 0
    for (const [k, v] of Object.entries(map)) {
      if (v) { state.cookies[k] = String(v); n += 1 }
    }
    return n > 0
  }

  return {
    login, seats, userInfo, openScope, book, cancel,
    hasSession, snapshot, restore, restoreCookieHeader, adoptCookies,
  }
}
