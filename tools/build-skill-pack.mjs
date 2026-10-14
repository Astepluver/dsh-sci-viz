/**
 * 把技能打成一个自包含的包，随插件一起走。
 *
 * 为什么需要：插件的目标是「分享出去，对方装上就能用技能库的全部内容」。
 * 所以技能正文必须进包，而不是依赖作者机器上的某个目录。
 *
 * 打包策略（都量过）：
 *   · SKILL.md 正文合计 **2.3 MB** —— 全带。
 *   · scripts / references / assets 等附属资源合计 **59 MB** —— 不带，
 *     只记下每个技能有哪些附属文件（清单几百字节），让 AI 知道这个技能期望什么、
 *     缺什么，必要时告诉用户去补。
 *   · 再 gzip 一层：磁盘上约 0.8 MB。
 *
 * 输出：
 *   data/skill-pack.json      人类可读（调试用，可删）
 *   data/skill-pack.json.gz   运行时真正读的（插件里只留这个）
 *
 * 用法：node tools/build-skill-pack.mjs [--dir=路径:层名 ...] [--keep-json]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
const OUT_JSON = join(PLUGIN, 'data', 'skill-pack.json')
const OUT_GZ = join(PLUGIN, 'data', 'skill-pack.json.gz')

const dirArgs = process.argv.slice(2).filter((a) => a.startsWith('--dir=')).map((a) => {
  const [dir, layer = 'library'] = a.slice(6).split(':')
  return { dir, layer }
})
const DIRS = dirArgs.length ? dirArgs : [
  { dir: '<技能目录>', layer: 'ready' },
  { dir: '<技能库目录>', layer: 'library' },
]

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
    contentBytes += content.length
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

const pack = {
  version: 1,
  generatedAt: new Date().toISOString().slice(0, 10),
  builtFrom: DIRS.map((d) => d.dir),
  note: '只包含 SKILL.md 正文；scripts/references 等附属资源未打包（源目录里合计约 59 MB），各技能的 resources 字段列出它们期望的文件。',
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

console.log(`技能 ${skills.length} 个｜正文 ${(contentBytes / 1024 / 1024).toFixed(2)} MB`)
console.log(`附属资源 ${resourceCount} 个文件（已记清单，未打包）`)
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
