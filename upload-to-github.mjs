// 用 GitHub Contents API 上传整个目录（不需要装 git）
// 用法：node upload-to-github.mjs <token> [owner/repo] [branch]
// 例：  node upload-to-github.mjs ghp_xxx 你的用户名/caopazi-V2 main
import fs from 'node:fs'
import path from 'node:path'

const TOKEN = process.argv[2] || process.env.GITHUB_TOKEN
const REPO = process.argv[3] || ''
const BRANCH = process.argv[4] || 'main'
if (!TOKEN || !REPO) {
  console.error('用法: node upload-to-github.mjs <token> <owner/repo> [branch]')
  process.exit(1)
}

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const SKIP_DIRS = new Set(['.git', 'node_modules', 'logs', 'artifacts', '.secrets'])
const SKIP_FILES = new Set(['config.json', 'upload-to-github.mjs', 'DRY'])

const H = {
  authorization: `Bearer ${TOKEN}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'caopazi-V2-uploader',
  'x-github-api-version': '2022-11-28',
  'content-type': 'application/json',
}

function walk(dir, base = '') {
  const out = []
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    const rel = base ? base + '/' + name : name
    const st = fs.statSync(full)
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue
      out.push(...walk(full, rel))
    } else {
      if (SKIP_FILES.has(name)) continue
      out.push(rel)
    }
  }
  return out
}

async function getSha(p) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${encodeURI(p)}?ref=${BRANCH}`, { headers: H })
  if (r.status === 404) return null
  if (!r.ok) return null
  const j = await r.json()
  return j.sha || null
}

const files = walk(ROOT)
console.log(`仓库: ${REPO}  分支: ${BRANCH}  待上传: ${files.length} 个文件`)

let ok = 0
for (const rel of files) {
  const content = fs.readFileSync(path.join(ROOT, rel)).toString('base64')
  const sha = await getSha(rel)
  const body = {
    message: `add ${rel}`,
    content,
    branch: BRANCH,
  }
  if (sha) body.sha = sha
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${encodeURI(rel)}`, {
    method: 'PUT', headers: H, body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  if (r.ok) {
    ok++
    console.log(`  ✅ ${rel}`)
  } else {
    const t = await r.text()
    console.log(`  ❌ ${rel}  HTTP ${r.status}  ${t.slice(0, 160)}`)
  }
}
console.log(`完成: ${ok}/${files.length}`)
process.exit(ok === files.length ? 0 : 2)
