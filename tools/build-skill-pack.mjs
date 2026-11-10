/**
 * 把技能打成一个自包含的包，随插件一起走。
 *
 * 为什么需要：插件的目标是「分享出去，对方装上就能用技能库的全部内容」。
 * 所以技能正文必须进包，而不是依赖作者机器上的某个目录。
 *
 * 打包策略（数字都在构建时实测，不写死 —— 写死过一次就过期了）：
 *   · SKILL.md 正文（UTF-8 字节）—— 全带。
 *   · scripts / references / assets 等附属资源（累计几十 MB）—— 不带，
 *     只记下每个技能有哪些附属文件（清单几百字节），让 AI 知道这个技能期望什么、
 *     缺什么，必要时告诉用户去补。
 *   · 再 gzip 一层：磁盘上不到 1 MB。
 *
 * 输出：
 *   data/skill-pack.json      人类可读（调试用，可删）
 *   data/skill-pack.json.gz   运行时真正读的（插件里只留这个）
 *
 * 用法：node tools/build-skill-pack.mjs [--dir=路径:层名 ...] [--keep-json]
 *      覆盖默认目录：DSH_SKILLS_DIR=... DSH_SKILL_LIBRARY_DIR=... node tools/build-skill-pack.mjs
 *
 * 安全：技能数低于 --min（默认 200）或为 0 时**直接中止**，不写文件 ——
 *       免得一次路径推导失误就用空包覆盖掉全部技能（真出过一次）。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join, dirname, relative } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
const OUT_JSON = join(PLUGIN, 'data', 'skill-pack.json')
const OUT_GZ = join(PLUGIN, 'data', 'skill-pack.json.gz')

/**
 * 本地日期 YYYY-MM-DD。
 * 不用 `toISOString().slice(0,10)` —— 那个取的是 UTC 日期，UTC+8 凌晨构建会「倒退一天」。
 * （踩过两次：一次写死成 UTC，一次改成调用 localDate() 却忘了定义它。）
 */
function localDate() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const dirArgs = process.argv.slice(2).filter((a) => a.startsWith('--dir=')).map((a) => {
  const [dir, layer = 'library'] = a.slice(6).split(':')
  return { dir, layer }
})
// 默认目录从「当前用户」推导，不写死盘符和用户名（发布给别人的机器也要能跑）；
// 需要时用环境变量覆盖：DSH_SKILLS_DIR（ready 层）/ DSH_SKILL_LIBRARY_DIR（library 层）。
//
// ⚠ 这里踩过坑（2026-10-18）：本机家目录是 `<家目录>`（本机家目录本身就带一级 `dsh`），而技能实际在
//   `<家目录>\.dsh\skills`。老的推导式 `homedir()/.dsh/skills` 指向
//   `<家目录>\.dsh\skills` —— 不存在，于是脚本**扫出 0 个技能，写出一个 1 KB 的空包
//   覆盖掉 222 个技能**（靠备份才救回来）。所以：候选路径要多个、要必须命中，且空包必须中止。
const dirExists = (p) => { try { return statSync(p).isDirectory() } catch { return false } }
const firstExisting = (...cands) => cands.find(dirExists)

const READY_CANDIDATES = [
  process.env.DSH_SKILLS_DIR,
  join(homedir(), '.dsh', 'skills'),
  // 家目录本身是一层工作目录（本机就是这种）时的形态
  join(homedir(), 'dsh', '.dsh', 'skills'),
].filter(Boolean)
const READY_DIR = dirArgs.length ? null : (firstExisting(...READY_CANDIDATES) ?? READY_CANDIDATES[0])

const LIBRARY_CANDIDATES = [
  process.env.DSH_SKILL_LIBRARY_DIR,
  ...(READY_DIR ? [join(dirname(dirname(READY_DIR)), '技能库'), join(homedir(), '技能库'), join(homedir(), 'dsh', '技能库')] : []),
].filter(Boolean)
const LIBRARY_DIR = dirArgs.length ? null : (firstExisting(...LIBRARY_CANDIDATES) ?? LIBRARY_CANDIDATES[0])

const DIRS = dirArgs.length ? dirArgs : [
  { dir: READY_DIR, layer: 'ready' },
  { dir: LIBRARY_DIR, layer: 'library' },
]
console.log(`扫描目录：\n  ready   ${READY_DIR}${dirExists(READY_DIR) ? '' : '  ← 不存在！'}\n  library ${LIBRARY_DIR}${dirExists(LIBRARY_DIR) ? '' : '  ← 不存在！'}`)

/** 逐行解析 frontmatter（这批文件大量使用 `description: >` 块标量）。 */
function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/)
  const out = {}
  if (!lines[0] || lines[0].trim() !== '---') return out
  let i = 1
  while (i < lines.length && lines[i].trim() !== '---') {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i])
    if (!m) {
      i += 1
      continue
    }
    const key = m[1]
    const inline = m[2].trim()
    if (inline === '>' || inline === '|' || inline === '>-' || inline === '|-') {
      const folded = inline.startsWith('>')
      const parts = []
      let j = i + 1
      while (j < lines.length && lines[j].trim() !== '---' &&
             (lines[j].trim() === '' || /^\s+\S/.test(lines[j]))) {
        if (lines[j].trim() !== '') parts.push(lines[j].trim())
        j += 1
      }
      out[key] = folded ? parts.join(' ') : parts.join('\n')
      i = j
    } else {
      out[key] = inline.replace(/^['"]|['"]$/g, '')
      i += 1
    }
  }
  return out
}

/** 列出技能的附属资源（相对路径，不含内容）。 */
function listResources(dir) {
  const out = []
  const walk = (base, prefix, depth) => {
    if (depth > 3) return
    let entries = []
    try {
      entries = readdirSync(base, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === 'SKILL.md' || e.name.startsWith('.')) continue
      const full = join(base, e.name)
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) walk(full, rel, depth + 1)
      else out.push(rel)
    }
  }
  walk(dir, '', 0)
  return out.sort()
}

// 已有分类表（中文说明 / 分类 / 标签 / 权重）
const taxonomyPath = join(PLUGIN, 'data', 'taxonomy.json')
const taxonomy = existsSync(taxonomyPath) ? JSON.parse(readFileSync(taxonomyPath, 'utf8')) : { skills: {} }

const skills = []
const problems = []
let contentBytes = 0
let resourceCount = 0
/** 附属资源的磁盘体积合计 —— 在构建时实测，喂给 note 与日志。 */
let resourceBytes = 0

for (const { dir, layer } of DIRS) {
  if (!existsSync(dir)) {
    problems.push(`目录不存在，已跳过：${dir}`)
    continue
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillDir = join(dir, entry.name)
    const skillFile = join(skillDir, 'SKILL.md')
    if (!existsSync(skillFile)) continue
    const content = readFileSync(skillFile, 'utf8')
    const fm = parseFrontmatter(content)
    const curated = taxonomy.skills?.[entry.name] ?? {}
    // 注册用的名字：优先 frontmatter 的 name，其次目录名
    const name = (fm.name || entry.name).trim()
    if (name !== entry.name) problems.push(`${entry.name} 的 frontmatter name 是「${name}」，与目录名不同`)
    const resources = listResources(skillDir)
    resourceCount += resources.length
    // 附属资源体积：把清单里每个文件的实际大小加起来。取不到就算了（不猜、不估）。
    for (const rel of resources) {
      try {
        const st = statSync(join(skillDir, rel))
        if (st.isFile()) resourceBytes += st.size
      } catch { /* 清单里有但磁盘上没有，跳过 */ }
    }
    /**
     * 正文按 **UTF-8 字节**统计。
     * 这里曾经写的是 `content.length` —— 那是 JS 字符串的 UTF-16 码元数，
     * 中文/emoji 一多就比真实字节少（实测少 45,623 B / -1.62%），字段名却叫 contentBytes。
     */
    contentBytes += Buffer.byteLength(content, 'utf8')
    skills.push({
      name,
      dir: entry.name,
      title: fm.title || curated.title || name,
      description: (fm.description || curated.desc || '').replace(/^[>#*\-\s]+/, '').replace(/\s+/g, ' ').trim(),
      zh: curated.zh || '',
      cat: curated.cat || 'tooling',
      tags: curated.tags || [],
      weight: curated.weight ?? 2,
      wasLayer: layer,
      resources,
      content,
    })
  }
}

// 重名检查：同层重名在 DSH 里是 first-wins + 警告，必须提前发现
const seen = new Map()
const dupes = []
for (const s of skills) {
  if (seen.has(s.name)) dupes.push(`${s.name}（${seen.get(s.name)} 与 ${s.dir}）`)
  else seen.set(s.name, s.dir)
}

const missingZh = skills.filter((s) => !s.zh).length
const missingDesc = skills.filter((s) => !s.description).length

/**
 * 空包护栏 —— 这次是血的教训。
 *
 * 2026-10-18：目录推导失误导致扫到 0 个技能，脚本**照常写出 1 KB 的空包**，
 * 把 222 个技能覆盖掉（靠备份救回）。一个构建脚本不该有这种"静默成功"的失败模式：
 * 技能数明显不对时宁可中止，也不能写文件。
 *
 * 目录结构变化让技能数天然下降时，显式传 `--min=N` 说明你知道自己在做什么。
 */
const MIN_SKILLS = Number((process.argv.find((a) => a.startsWith('--min=')) || '').slice(6)) || 200
if (skills.length < MIN_SKILLS) {
  console.error(`\n✗ 中止：只扫到 ${skills.length} 个技能（下限 ${MIN_SKILLS}），**没有写任何文件**。`)
  for (const d of DIRS) console.error(`    扫描目录 ${d.layer}: ${d.dir}${existsSync(d.dir) ? '' : '  ← 不存在'}`)
  console.error('  技能包没被动过；请用 DSH_SKILLS_DIR / DSH_SKILL_LIBRARY_DIR 指对目录，')
  console.error('  或确认确实要缩小技能库时显式传 --min=N。')
  process.exit(2)
}

const pack = {
  version: 1,
  // 本地日期，不用 toISOString() —— 那个取的是 UTC 日期，凌晨构建会"倒退一天"（本机 UTC+8 已踩到）
  generatedAt: localDate(),
  builtFrom: DIRS.map((d) => d.dir),
  note: `只包含 SKILL.md 正文（UTF-8 约 ${(contentBytes / 1024 / 1024).toFixed(2)} MB）；`
    + `scripts/references 等附属资源未打包（构建时实测合计约 ${(resourceBytes / 1024 / 1024).toFixed(0)} MB），`
    + `各技能的 resources 字段列出它们期望的文件。`,
  /** 分类表一并进包，运行期就不必再读 taxonomy.json */
  categories: taxonomy.categories ?? [],
  stats: {
    skills: skills.length,
    contentBytes,
    resources: resourceCount,
  },
  skills,
}

const json = JSON.stringify(pack)
writeFileSync(OUT_JSON, json, 'utf8')
const gz = gzipSync(Buffer.from(json, 'utf8'), { level: 9 })
writeFileSync(OUT_GZ, gz)
if (!process.argv.includes('--keep-json')) rmSync(OUT_JSON, { force: true })

console.log(`技能 ${skills.length} 个｜正文 ${(contentBytes / 1024 / 1024).toFixed(2)} MB（UTF-8 字节）`)
console.log(`附属资源 ${resourceCount} 个文件 · ${(resourceBytes / 1024 / 1024).toFixed(2)} MB（已记清单，未打包）`)
console.log(`skill-pack.json.gz  ${(gz.length / 1024).toFixed(0)} KB${process.argv.includes('--keep-json') ? `；json ${(json.length / 1024 / 1024).toFixed(2)} MB（--keep-json）` : ''}`)
console.log(`中文说明缺失 ${missingZh} 个｜英文说明缺失 ${missingDesc} 个`)
if (dupes.length) {
  console.log(`⚠ 重名 ${dupes.length} 个：`)
  for (const d of dupes.slice(0, 10)) console.log('   ' + d)
} else {
  console.log('重名检查：无')
}
if (problems.length) {
  console.log(`说明（${problems.length} 条，前 5 条）：`)
  for (const p of problems.slice(0, 5)) console.log('   ' + p)
}