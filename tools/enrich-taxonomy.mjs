/**
 * 把技能快照补全成「自包含」的版本。
 *
 * 背景：插件要能随取随用 —— 只拷插件目录到别的机器也得能用技能库。所以每个技能的
 * 标题与一句话英文说明在**构建时**从 SKILL.md 抄进 data/taxonomy.json，运行期不再
 * 依赖技能目录是否存在。
 *
 * 幂等：重复运行只覆盖 title/desc/snapshot 三个字段，已有的分类与中文说明原样保留。
 *
 * 用法：
 *   node tools/enrich-taxonomy.mjs                     # 用默认的两个技能目录
 *   node tools/enrich-taxonomy.mjs --dir=A:ready --dir=B:library
 *   node tools/enrich-taxonomy.mjs --check             # 只报告，不写文件
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TAXONOMY = join(HERE, '..', 'data', 'taxonomy.json')
const DESC_MAX = 160

const args = process.argv.slice(2)
const check = args.includes('--check')
const dirArgs = args.filter((a) => a.startsWith('--dir=')).map((a) => {
  const [dir, layer = 'library'] = a.slice(6).split(':')
  return { dir, layer }
})
const DIRS = dirArgs.length ? dirArgs : [
  { dir: '<技能目录>', layer: 'ready' },
  { dir: '<技能库目录>', layer: 'library' },
]

/**
 * 读 SKILL.md 的 frontmatter + 首段，抽 title / description。
 *
 * 逐行解析而不是正则：这一批 SKILL.md 大量使用 YAML 块标量
 * （`description: >` 后跟缩进的续行），正则抓到的只是那个 `>`。
 */
function readMeta(path) {
  const text = readFileSync(path, 'utf8')
  const lines = text.split(/\r?\n/)
  let title = ''
  let description = ''
  if (lines[0].trim() === '---') {
    let i = 1
    while (i < lines.length && lines[i].trim() !== '---') {
      const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i])
      if (m) {
        const key = m[1]
        const inline = m[2].trim()
        let value = inline
        if (inline === '>' || inline === '|' || inline === '>-' || inline === '|-') {
          // 块标量：收下面的缩进行
          const folded = inline.startsWith('>')
          const parts = []
          let j = i + 1
          while (j < lines.length && lines[j].trim() !== '---' && (lines[j].trim() === '' || /^\s+\S/.test(lines[j]))) {
            if (lines[j].trim() !== '') parts.push(lines[j].trim())
            j += 1
          }
          value = folded ? parts.join(' ') : parts.join('\n')
          i = j
        } else {
          i += 1
        }
        if (key === 'name') title = value.replace(/^['"]|['"]$/g, '')
        if (key === 'description') description = value.replace(/^['"]|['"]$/g, '')
      } else {
        i += 1
      }
    }
  }
  const body = text.replace(/^---[\s\S]*?\r?\n---\r?\n?/, '')
  if (!title) {
    const h1 = /^#\s+(.+)$/m.exec(body)
    if (h1) title = h1[1].trim()
  }
  if (!description) {
    const para = body.split(/\n\s*\n/).map((p) => p.trim())
      .find((p) => p && !p.startsWith('#') && !p.startsWith('```'))
    if (para) description = para.replace(/\s+/g, ' ')
  }
  return {
    title,
    description: description.replace(/^[>#*\-\s]+/, '').replace(/\s+/g, ' ').slice(0, DESC_MAX),
  }
}

const taxonomy = JSON.parse(readFileSync(TAXONOMY, 'utf8'))
const before = readFileSync(TAXONOMY).length

let enriched = 0
let missingFile = 0
const found = new Set()

for (const { dir, layer } of DIRS) {
  if (!existsSync(dir)) {
    console.log(`跳过不存在的目录：${dir}`)
    continue
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillFile = join(dir, entry.name, 'SKILL.md')
    if (!existsSync(skillFile)) continue
    const meta = readMeta(skillFile)
    const record = taxonomy.skills[entry.name]
    if (!record) {
      console.log(`⚠ 快照里没有 ${entry.name}（磁盘上有）—— 跳过，请先补分类`)
      missingFile += 1
      continue
    }
    if (record.title !== meta.title || record.desc !== meta.description) enriched += 1
    record.title = meta.title || record.title || entry.name
    record.desc = meta.description || record.desc || ''
    if (!record.layer) record.layer = layer
    found.add(entry.name)
  }
}

const notOnDisk = Object.keys(taxonomy.skills).filter((id) => !found.has(id))
taxonomy.snapshot = {
  generatedAt: new Date().toISOString().slice(0, 10),
  sourceDirs: DIRS.map((d) => d.dir),
  note: '标题与英文说明在构建时抄自各 SKILL.md；运行期不需要技能目录存在。',
  onDisk: found.size,
  snapshotOnly: notOnDisk.length,
}

const after = JSON.stringify(taxonomy, null, 1).length
console.log(`技能总数 ${Object.keys(taxonomy.skills).length}｜本次读到磁盘 ${found.size}｜仅快照 ${notOnDisk.length}`)
console.log(`更新了 ${enriched} 条的 title/desc；文件 ${(before / 1024).toFixed(1)} KB → ${(after / 1024).toFixed(1)} KB`)

if (check) {
  console.log('--check：未写入')
} else {
  writeFileSync(TAXONOMY, JSON.stringify(taxonomy, null, 1))
  console.log(`已写入 ${TAXONOMY}`)
}
