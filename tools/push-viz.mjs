/**
 * 不经过工具注册，直接把一份可视化文档推进面板。
 *
 * 这是插件架构里刻意留的第二条路：`state/current.json` 是唯一真源，浏览器轮询它，
 * 所以**任何进程**都能推图 —— 不依赖模型工具是否注册成功，也不依赖 DSH 的插件重载。
 * 用途：宿主工具表还没刷新时救急、从批处理脚本批量出图、或者你自己在终端里试参数。
 *
 * 用法：
 *   node tools/push-viz.mjs structure <路径|PDB ID> [选项]
 *   node tools/push-viz.mjs clear
 *   node tools/push-viz.mjs show           # 打印当前状态文件里的文档概要
 *
 * 选项（structure）：
 *   --label=标题          --note=注解          --style=cartoon|trace|ballstick|spacefill|ligand
 *   --color=chain|ss|bfactor|resname|rainbow|element
 *   --highlight=S315T,315,D94G                --termini
 *   --focus=x,y,z                             --chains=A,B
 *   --state=路径（默认插件目录/state/current.json）
 *
 * 注意：PDB ID 需要联网（RCSB）；本地路径直接读。
 */
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseStructure, compileStructure, parseSiteSpec } from '../lib/core/structure.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')

const argv = process.argv.slice(2)
const cmd = argv[0]
const flags = new Map()
const positional = []
for (const a of argv.slice(1)) {
  if (a.startsWith('--')) {
    const [k, ...rest] = a.slice(2).split('=')
    flags.set(k, rest.join('=') || 'true')
  } else positional.push(a)
}
const statePath = flags.get('state') || join(PLUGIN, 'state', 'current.json')
const list = (name) => {
  const v = flags.get(name)
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []
}

const writeState = (doc) => {
  mkdirSync(dirname(statePath), { recursive: true })
  writeFileSync(statePath, JSON.stringify({ ts: Date.now(), doc }), 'utf8')
  console.log(`已写入 ${statePath}（${(JSON.stringify({ doc }).length / 1024).toFixed(0)} KB）— 面板会在 1.5 秒内刷新`)
}

if (cmd === 'clear') {
  writeState({ kind: 'empty', title: '（已清空）' })
  process.exit(0)
}

if (cmd === 'show' || !cmd) {
  try {
    const doc = JSON.parse(readFileSync(statePath, 'utf8')).doc
    console.log(`kind: ${doc.kind}`)
    console.log(`title: ${doc.title ?? '—'}`)
    if (doc.kind === 'structure') {
      console.log(`链: ${doc.stats.chains}，残基: ${doc.stats.proteinResidues}，原子: ${doc.stats.atoms}`)
      console.log(`视图: style=${doc.view.style} colorBy=${doc.view.colorBy} termini=${!!doc.view.termini} focus=${doc.view.focus ?? '—'}`)
      console.log(`高亮: ${(doc.highlight || []).map((h) => h.label).join('、') || '（无）'}`)
    } else if (doc.kind === 'chart') {
      console.log(`面板: ${(doc.panels || []).map((p) => p.title).join(' / ')}`)
    }
  } catch (e) {
    console.log(`读不到状态文件：${e.message}`)
  }
  process.exit(0)
}

if (cmd !== 'structure') {
  console.log(`不认识的命令：${cmd}（可用：structure / clear / show）`)
  process.exit(1)
}

const source = positional[0]
if (!source) {
  console.log('缺少结构来源。用法：node tools/push-viz.mjs structure <路径|PDB ID> [选项]')
  process.exit(1)
}

/** 4 位 PDB ID → RCSB 下载；否则当本地路径读。 */
async function load(source) {
  if (/^[0-9][A-Za-z0-9]{3}$/.test(source)) {
    for (const ext of ['pdb', 'cif']) {
      const url = `https://files.rcsb.org/download/${source.toUpperCase()}.${ext}`
      const res = await fetch(url).catch(() => null)
      if (res && res.ok) {
        const body = await res.text()
        if (body.length > 200) {
          return { text: body, format: ext === 'cif' ? 'mmcif' : 'pdb', path: url, id: source.toUpperCase() }
        }
      }
    }
    throw new Error(`从 RCSB 下载 ${source} 失败（检查网络）`)
  }
  const info = statSync(source)
  const ext = extname(source).toLowerCase()
  return {
    text: readFileSync(source, 'utf8'),
    format: ext === '.cif' || ext === '.mmcif' ? 'mmcif' : 'pdb',
    path: source,
    id: basename(source, ext),
    bytes: info.size,
  }
}

const loaded = await load(source)
const parsed = parseStructure(loaded.text, loaded.format)
const doc = compileStructure(parsed, {
  path: loaded.path,
  format: loaded.format,
  bytes: loaded.text.length,
  sourceId: loaded.id,
  label: flags.get('label'),
})

// 高亮：位点（红）
const highlight = []
for (const spec of list('highlight')) {
  const site = parseSiteSpec(spec)
  if (!site) {
    console.log(`  跳过看不懂的位点写法「${spec}」`)
    continue
  }
  const chain = doc.chains.find((c) => (!site.chain || c.id === site.chain) &&
    site.resSeq >= (c.first ?? 0) && site.resSeq <= (c.last ?? -1))
  if (!chain) {
    console.log(`  结构里没有残基 ${spec}`)
    continue
  }
  highlight.push({
    chain: chain.id,
    resSeq: site.resSeq,
    label: `${site.wildtype ?? ''}${site.resSeq}${site.mutant ?? ''}`,
    role: 'site',
  })
}
doc.highlight = highlight

const focus = (flags.get('focus') || '').split(',').map(Number)
doc.view = {
  style: flags.get('style') || 'cartoon',
  colorBy: flags.get('color') || 'chain',
  chains: list('chains'),
  focus: focus.length === 3 && focus.every(Number.isFinite) ? focus : null,
  termini: flags.get('termini') === 'true',
  note: flags.get('note') || '',
}
doc.pushedAt = Date.now()

writeState(doc)
console.log(`  ${doc.stats.chains} 条链 / ${doc.stats.proteinResidues} 残基 / ${doc.stats.atoms} 原子`)
console.log(`  视图：style=${doc.view.style} colorBy=${doc.view.colorBy} termini=${doc.view.termini}`)
if (highlight.length) console.log(`  高亮：${highlight.map((h) => h.label).join('、')}`)
