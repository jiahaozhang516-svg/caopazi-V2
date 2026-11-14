// 校园网 Portal（Dr.COM）自动认证
//
// 思路：Portal 在校园网本地，没外网也能访问；所以"没网"时先打 Portal 认证，再继续。
// 两种策略：
//   A. 经典表单 POST（老版 Dr.COM：/eportal/?c=ACSetting&a=Login，字段 DDDDD/upass）
//   B. 浏览器驱动（新版 SPA：找到账号/密码框，填值、点登录，等跳转）
import { Browser } from './browser.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 外网是否可用（204 探测，不走缓存） */
export async function isOnline(timeoutMs = 6000) {
  try {
    const r = await fetch('http://connect.rom.miui.com/generate_204?t=' + Date.now(), {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    })
    return r.status === 204
  } catch {
    return false
  }
}

/**
 * 经典 Dr.COM 表单登录（备用路径）
 * 实测：南林门户的登录表单 action 为空，提交到 http://<portal>/ （80 端口），
 * 不是 801 的 /eportal/...；801 那个地址是管理控制台，POST 会 500。
 */
export async function loginClassic(portalIp, user, pass) {
  const url = `http://${portalIp}/`
  const body = new URLSearchParams({
    DDDDD: user, upass: pass,
    R1: '0', R2: '0', R3: '0', R6: '0', para: '00', '0MKKey': '123456',
    buttonClicked: '', redirect_url: '', err_flag: '', username: '', password: '', user: '', cmd: '', Login: '',
    v: String(Date.now()), lang: 'zh',
  }).toString()
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15000),
    redirect: 'manual',
  })
  const t = await r.text()
  const okMark = /Dr\.COMWebLoginID_3|登录成功|认证成功|success/i.test(t)
  return { ok: okMark, status: r.status, body: t.slice(0, 300) }
}

/** 在页面里填表单并提交（对 SPA / 普通表单都适用） */
function fillAndSubmitScript(user, pass) {
  return `(function(){
    const U=${JSON.stringify(user)}, P=${JSON.stringify(pass)};
    const setVal=(el,v)=>{
      const d=Object.getOwnPropertyDescriptor(el.__proto__,'value');
      if(d&&d.set) d.set.call(el,v); else el.value=v;
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
      el.dispatchEvent(new Event('blur',{bubbles:true}));
    };
    const vis=(el)=>{const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'};
    const inputs=[...document.querySelectorAll('input')].filter(vis);
    const pwd=inputs.find(i=>i.type==='password');
    let usr=inputs.find(i=>i.type==='text'||i.type==='tel'||i.type==='');
    if(!usr&&pwd){const all=inputs.filter(i=>i!==pwd); usr=all[0]}
    if(!usr||!pwd) return {ok:false,why:'no-inputs',count:inputs.length,types:inputs.map(i=>i.type).join(',')};
    setVal(usr,U); setVal(pwd,P);
    // 只在真正的可点控件里找，且不要 div —— 页面上有包含"登录"二字的大容器，
    // 之前误点它导致什么都没发生。
    const cands=[...document.querySelectorAll('input[type=submit],input[type=button],button,a')]
      .filter(el=>vis(el)&&!el.disabled)
      .map(el=>{
        const raw=(el.value||el.innerText||'').trim();
        return {el, raw, norm:raw.replace(/\\s+/g,'')};
      })
      .filter(o=>/登录|认证|连接|login/i.test(o.norm))
      .sort((a,b)=>a.raw.length-b.raw.length); // 文字最短的最像按钮
    if(cands.length){
      const pick=cands[0];
      pick.el.click();
      return {ok:true,clicked:pick.raw.slice(0,20),tag:pick.el.tagName};
    }
    // 没有按钮才退回到回车/表单提交
    pwd.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,bubbles:true}));
    const f=pwd.form; if(f){ f.submit(); return {ok:true,submitted:'form'} }
    return {ok:false,why:'no-button'};
  })()`
}

/** 浏览器驱动登录：打开 Portal，填表，提交，等网络恢复 */
export async function loginViaBrowser({ portalUrl, user, pass, waitMs = 45000, log = () => {} }) {
  const b = new Browser()
  try {
    await b.launch({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0' })
    await b.navigate(portalUrl)
    await sleep(3500)
    const title = await b.eval('document.title')
    log('Portal 页面: ' + JSON.stringify(title) + ' ' + (await b.eval('location.href')))
    const r = await b.eval(fillAndSubmitScript(user, pass))
    log('填表结果: ' + JSON.stringify(r))
    const t0 = Date.now()
    while (Date.now() - t0 < waitMs) {
      await sleep(2500)
      if (await isOnline()) {
        log('Portal 认证成功，网络已恢复')
        return { ok: true, via: 'browser', fill: r }
      }
    }
    return { ok: false, via: 'browser', fill: r, title }
  } finally {
    try { await b.close() } catch {}
  }
}

/**
 * 确保在线：先看外网，不通就浏览器驱动登录（实测最可靠），再退回经典表单。
 * @returns {Promise<{ok:boolean, via?:string}>}
 */
export async function ensureOnline({ portalIp, user, pass, portalUrl, log = () => {}, tries = 1 } = {}) {
  if (await isOnline()) return { ok: true, via: 'already' }
  for (let i = 1; i <= tries; i++) {
    log(`外网不可用，尝试 Portal 认证（第 ${i} 轮）`)
    // ① 浏览器填表 + 点「登 录」（2026-11-14 实测成功，约 3 秒恢复）
    try {
      const b = await loginViaBrowser({ portalUrl, user, pass, log })
      if (b.ok) return { ok: true, via: 'browser' }
    } catch (e) {
      log('浏览器认证失败: ' + e.message)
    }
    // ② 经典表单兜底
    if (portalIp) {
      try {
        const c = await loginClassic(portalIp, user, pass)
        log('经典表单:', c.ok ? '命中成功标记' : '未命中', c.status)
        if (c.ok && (await isOnline())) return { ok: true, via: 'classic' }
      } catch (e) {
        log('经典表单失败: ' + e.message)
      }
    }
    await sleep(2000)
  }
  return { ok: false }
}
