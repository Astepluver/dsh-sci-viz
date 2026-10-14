/**
 * dsh-sci-viz — 宿主半边（DSH Host half）
 *
 * 职责：
 *  1. 把「技能库」暴露成一个可检索的数据源（199 个技能的目录名 + 分类 + 中文说明），
 *     技能正文不进上下文，只有打开某一条时才按需读取 SKILL.md 的头部。
 *  2. 把「可视化文档」写成一份状态文件，并在回路地址上提供 JSON 路由供浏览器端轮询。
 *     状态文件是唯一真源 —— 工具、命令行、外部脚本三条路都只是写这一个文件。
 *  3. 注册 5 个模型可调用工具：sci_viz_structure / sci_viz_stats / sci_viz_plot /
 *     sci_viz_genomics / sci_viz_skills。
 *  4. 注册「科研可视化验证规程」：一段系统提示（分四层讲清图该怎么验）+ 一道子代理守卫
 *     （子代理只允许写 <会话 cwd>/.dsh-verify/）。见 lib/verify-protocol.js。
 *
 * 依赖：只用 node: 内置模块。刻意**不** import @deepseek-ai/* —— 插件以 link: 方式
 * 安装在工作区目录，bare specifier 解析不到 profile 的 node_modules；ctx.tools.register
 * 接受形如 ToolDefinition 的普通对象，因此 defineTool 也不是必需的（见 tools/README）。
 *
 * @module dsh-sci-viz
 */
import { mkdir, readFile, writeFile, stat, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join, resolve, basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

import * as N from './core/numeric.js'
import { parseStructure, compileStructure, parseSiteSpec, wrapSequence } from './core/structure.js'
import { applyVerifyProtocol } from './verify-protocol.js'

/** cordis 插件名（与 cordis.patch.yml 的 insert id 对应）。 */
export const name = 'dsh-sci-viz'

/** 需要 webServer 才能挂路由。tools 走 ctx.get 软获取，避免硬依赖拖垮挂载。 */
export const inject = ['webServer']

const HERE = fileURLToPath(new URL('..', import.meta.url))
const API = '/api/sci-viz'

const DEFAULTS = {
  /**
   * 自带的技能包 —— **这是「分享出去就能用」的关键**。
   *
   * 里面是 195 个技能的完整 SKILL.md 正文（由 tools/build-skill-pack.mjs 打包并 gzip，
   * 约 0.85 MB）。插件挂载时把它们全部注册进 DSH 的技能系统，对方装上就立刻可用，
   * 不需要任何本地技能目录。
   */
  skillPackPath: join(HERE, 'data', 'skill-pack.json.gz'),
  /**
   * 额外的本地技能目录 —— **可选**。
   *
   * 用途有二：一是让你自己后续往里丢新技能（会自动出现在技能库里）；
   * 二是当源目录就在本机时，点开技能详情能读到 scripts/references 等附属资源
   * （附属资源合计约 59 MB，没有随包分发）。
   * 每一项：{ dir: 绝对路径, layer: 'ready' | 'library', zh: 展示名 }
   */
  skillsDirs: [],
  /** 分类表（构建技能包的输入；运行期只用它的 categories 字段） */
  taxonomyPath: join(HERE, 'data', 'taxonomy.json'),
  /** 可视化状态文件所在目录（相对插件目录，天然可迁移） */
  stateDir: join(HERE, 'state'),
  /** sci_viz_structure 给相对路径时的搜索根目录；默认为进程工作目录 */
  structureRoots: [],
  /** 单个结构文档上限（字节），超过则不落盘，只留在内存，避免状态文件膨胀 */
  maxStateBytes: 6 * 1024 * 1024,
  /** RCSB 下载地址模板 */
  rcsb: 'https://files.rcsb.org/download',
  /** 技能正文一次最多回给浏览器的字符数 */
  skillPreviewChars: 6000,
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

function isLoopback(address) {
  if (typeof address !== 'string') return false
  const a = address.toLowerCase()
  if (a === '::1') return true
  if (a.startsWith('::ffff:')) return isLoopback(a.slice(7))
  const parts = a.split('.')
  return parts.length === 4 && parts[0] === '127'
}

/** 读 JSON，失败返回 undefined。 */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** 只保留有限数字。 */
function nums(list) {
  return N.finite(Array.isArray(list) ? list : [])
}

/**
 * 极简 JSON Schema 校验（只覆盖本插件用到的子集）。
 *
 * 为什么需要：`ctx.tools.register()` 直接接受 registry-ready 的形状，
 * 但**不会**替我们校验模型传来的参数 —— 那一步是 `defineTool` 在包装 execute 时做的
 * （dsh-tools/lib/index.js:850）。插件不能 import 核心包（link: 安装的目录解析不到
 * profile 的 node_modules），所以这里自己补上，错误信息也顺便写成中文。
 *
 * @returns {string[]} 违规说明；空数组表示通过
 */
function validateAgainst(schema, value, path = '') {
  const out = []
  if (schema === undefined || schema === null) return out
  const label = path || '参数'
  if (Array.isArray(schema.oneOf) && schema.oneOf.length) {
    const ok = schema.oneOf.some((sub) => validateAgainst(sub, value, path).length === 0)
    if (!ok) out.push(`${label} 不满足任何一种允许的形式`)
    return out
  }
  const type = schema.type
  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      out.push(`${label} 应为对象`)
      return out
    }
    const props = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      if (value[key] === undefined || value[key] === null) out.push(`缺少必填参数 ${path ? `${path}.` : ''}${key}`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(props, key)) out.push(`不认识的参数 ${path ? `${path}.` : ''}${key}`)
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (value[key] === undefined || value[key] === null) continue
      out.push(...validateAgainst(sub, value[key], path ? `${path}.${key}` : key))
    }
    return out
  }
  if (type === 'array') {
    if (!Array.isArray(value)) {
      out.push(`${label} 应为数组`)
      return out
    }
    if (schema.items) {
      value.forEach((item, i) => {
        out.push(...validateAgainst(schema.items, item, `${label}[${i}]`))
      })
    }
    return out
  }
  if (type === 'string') {
    if (typeof value !== 'string') {
      out.push(`${label} 应为字符串`)
      return out
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      out.push(`${label} 只能是 ${schema.enum.join(' / ')}，收到 ${JSON.stringify(value)}`)
    }
    return out
  }
  if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      out.push(`${label} 应为数字`)
      return out
    }
    if (type === 'integer' && !Number.isInteger(value)) out.push(`${label} 应为整数`)
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      out.push(`${label} 只能是 ${schema.enum.join(' / ')}，收到 ${value}`)
    }
    return out
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') out.push(`${label} 应为 true / false`)
    return out
  }
  return out
}

/**
 * 本地 defineTool：把「作者友好」的写法翻成 registry-ready 的形状。
 *
 * 与 @deepseek-ai/dsh-tools 的 defineTool 的差别：这里 `parameters` / `output.schema`
 * 直接写**原始 JSON Schema**（`required: [...]` 数组），而不是 DSL 的 `required: true`。
 * 原因是 register() 只对 output.schema 做 assertSupportedJsonSchema（原始子集），
 * 不做 DSL 转换；写错形状会在挂载时直接抛错。
 */
function localTool(def) {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    output: def.output,
    async execute(args, exec) {
      const violations = validateAgainst(def.parameters, args ?? {})
      if (violations.length > 0) throw new Error(`sci_viz 参数不合法：${violations.slice(0, 6).join('；')}`)
      return def.execute(args ?? {}, exec)
    },
  }
}

// ---------------------------------------------------------------------------
// 技能库
// ---------------------------------------------------------------------------

/** 读一个 JSON 请求体，带大小上限（拖进来的 PDB 文本也走这里）。 */
function readJsonBody(req, limitBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error(`请求体超过 ${Math.round(limitBytes / 1024 / 1024)} MB 上限`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch (e) {
        reject(new Error(`请求体不是合法 JSON：${e.message}`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 面板自己发起操作的公共外壳：校验参数 → 干活 → 写状态 → 回文档。
 *
 * 「即用」的关键就在这里：面板上的按钮和模型调用的工具**走同一个 buildXxxDoc**，
 * 所以界面上能做的事不比工具少，出错信息也一模一样。
 */
function actionRoute(path, handler) {
  return {
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (!isLoopback(req.socket?.remoteAddress ?? '')) {
        writeJson(res, 403, { ok: false, error: 'loopback only' })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const result = await handler(body)
        writeJson(res, 200, { ok: true, ...result })
      } catch (e) {
        // 参数错误、找不到文件、数据不合法都走这里 —— 400 + 一句人话，面板直接弹提示
        writeJson(res, 400, { ok: false, error: e?.message ?? String(e) })
      }
    },
  }
}

/** 面板路由用同一个校验器，报错信息与工具完全一致。 */
function assertParams(schema, args) {
  const violations = validateAgainst(schema, args ?? {})
  if (violations.length > 0) throw new Error(violations.slice(0, 4).join('；'))
  return args
}

/**
 * 组装技能清单。
 *
 * **快照优先**：taxonomy.json 里已经有 195 个技能的分类、中文说明、标签与权重，
 * 所以插件本身不依赖任何本地技能包 —— 换机器、只拷插件目录，技能库照样能用。
 * 配置了 skillsDirs 时再叠加「真实文件」这一层：补上 title/description、SKILL.md
 * 路径、体积、是否有 scripts/references，并让点开详情能读到正文。目录不存在就跳过，
 * 不报错也不降级。
 */
async function buildSkillCatalog(config) {
  const taxonomy = (await readJson(config.taxonomyPath)) ?? { categories: [], skills: {}, layers: {} }
  const layers = (config.skillsDirs ?? []).map((entry) => ({
    id: entry.layer ?? 'library',
    dir: entry.dir,
    zh: entry.zh ?? entry.layer ?? '技能目录',
  }))

  /** 每条记录先由快照建立骨架。 */
  const skills = new Map()
  for (const [id, meta] of Object.entries(taxonomy.skills ?? {})) {
    skills.set(id, {
      id,
      layer: meta.layer ?? 'library',
      layerZh: '',
      path: '',
      dir: '',
      title: meta.title || id,
      description: meta.desc || '',
      zh: meta.zh ?? '',
      cat: meta.cat ?? 'tooling',
      viz: meta.viz ?? ['none'],
      tags: meta.tags ?? [],
      weight: meta.weight ?? 2,
      bytes: 0,
      hasScripts: false,
      hasReferences: false,
      /** 正文是否可读（决定详情的「打开正文」是不是亮着） */
      readable: false,
    })
  }

  // 叠加真实文件：目录扫描是「增强」，不是「前提」。
  for (const layer of layers) {
    if (!layer.dir || !existsSync(layer.dir)) continue
    let entries = []
    try {
      entries = await readdir(layer.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(layer.dir, entry.name)
      const skillFile = join(dir, 'SKILL.md')
      if (!existsSync(skillFile)) continue
      const meta = await readSkillMeta(skillFile)
      const existing = skills.get(entry.name)
      const merged = existing ?? {
        id: entry.name,
        layer: layer.id,
        title: entry.name,
        description: '',
        zh: '',
        cat: 'tooling',
        viz: ['none'],
        tags: [],
        weight: 2,
      }
      skills.set(entry.name, {
        ...merged,
        layer: layer.id,
        layerZh: layer.zh,
        path: skillFile,
        dir,
        readable: true,
        title: (meta && meta.title) || merged.title || entry.name,
        description: (meta && meta.description) || merged.description || '',
        bytes: meta ? meta.bytes : 0,
        hasScripts: !!(meta && meta.hasScripts),
        hasReferences: !!(meta && meta.hasReferences),
      })
    }
  }

  const list = [...skills.values()].map((s) => ({ ...s, layerZh: s.layerZh || layerLabel(taxonomy, s.layer) }))
  return {
    version: taxonomy.version ?? 1,
    /** 快照来自哪里（换机器后这段就是「为什么没有本地目录也能用」的说明） */
    snapshot: taxonomy.snapshot ?? null,
    portable: layers.every((l) => !l.dir || !existsSync(l.dir)),
    categories: taxonomy.categories ?? [],
    layers: [
      { id: 'ready', zh: layerLabel(taxonomy, 'ready') },
      { id: 'library', zh: layerLabel(taxonomy, 'library') },
    ],
    counts: {
      total: list.length,
      ready: list.filter((s) => s.layer === 'ready').length,
      library: list.filter((s) => s.layer === 'library').length,
      readable: list.filter((s) => s.readable).length,
    },
    skills: list,
  }
}

function layerLabel(taxonomy, id) {
  if (id === 'ready') return (taxonomy.layers && taxonomy.layers.ready) || '即用层'
  return (taxonomy.layers && taxonomy.layers.library) || '技能库层'
}

/**
 * 读取 SKILL.md 的 frontmatter（name / description）。
 *
 * 逐行解析而不是正则：这批 SKILL.md 大量使用 YAML 块标量（`description: >`
 * 后跟缩进续行），正则只会抓到那个 `>` —— 插件面板里就会显示成一个孤零零的尖括号。
 * 带 mtime 缓存：目录扫描每次请求都做，但文件只在改动后才重读。
 */
const metaCache = new Map()

async function readSkillMeta(path) {
  try {
    const info = await stat(path)
    const cached = metaCache.get(path)
    if (cached && cached.mtimeMs === info.mtimeMs) return cached.value
    const text = await readFile(path, 'utf8')
    const lines = text.split(/\r?\n/)
    let title = ''
    let description = ''
    if (lines[0] && lines[0].trim() === '---') {
      let i = 1
      while (i < lines.length && lines[i].trim() !== '---') {
        const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i])
        if (!m) {
          i += 1
          continue
        }
        const key = m[1]
        const inline = m[2].trim()
        let value = inline
        if (inline === '>' || inline === '|' || inline === '>-' || inline === '|-') {
          const folded = inline.startsWith('>')
          const parts = []
          let j = i + 1
          while (j < lines.length && lines[j].trim() !== '---' &&
                 (lines[j].trim() === '' || /^\s+\S/.test(lines[j]))) {
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
    const dir = path.replace(/[\\/]SKILL\.md$/, '')
    const value = {
      title,
      description: description.replace(/^[>#*\-\s]+/, '').replace(/\s+/g, ' ').slice(0, 400),
      bytes: info.size,
      hasScripts: existsSync(join(dir, 'scripts')),
      hasReferences: existsSync(join(dir, 'references')),
    }
    metaCache.set(path, { mtimeMs: info.mtimeMs, value })
    return value
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// 自带的技能包：插件分发的一部分，运行期不碰任何本地技能目录
// ---------------------------------------------------------------------------

/** 按路径缓存，避免每次请求都解压 2.3 MB JSON。 */
const packCache = new Map()

/**
 * 载入技能包（gzip 的 JSON）。
 * 包坏了不能拖垮插件：返回一个带 error 的空包，其它功能照常。
 */
function getSkillPack(config) {
  const path = config.skillPackPath
  if (!path) return Promise.resolve({ error: '未配置 skillPackPath', skills: [] })
  if (packCache.has(path)) return packCache.get(path)
  const promise = (async () => {
    if (!existsSync(path)) return { error: `技能包不存在：${path}`, skills: [] }
    try {
      const buf = await readFile(path)
      const text = path.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8')
      const pack = JSON.parse(text)
      if (!pack || !Array.isArray(pack.skills)) return { error: '技能包结构不对', skills: [] }
      return pack
    } catch (e) {
      return { error: `技能包读取失败：${e.message}`, skills: [] }
    }
  })()
  packCache.set(path, promise)
  return promise
}

/**
 * 组装面板用的技能清单：**以包为主**，再叠加本地目录里多出来的技能。
 *
 * 字段形状与旧的「快照 + 目录」版本保持一致，所以 /skills 路由一行都不用改。
 * 差别只在语义：layer 不再是「即用层 / 技能库层」（那是原工作区目录结构的划分），
 * 而是「插件自带 / 本地目录」—— 对拿到插件的人来说，前者才是重点。
 */
async function buildBundledCatalog(config) {
  const pack = await getSkillPack(config)
  const taxonomy = (await readJson(config.taxonomyPath)) ?? { categories: [] }

  const skills = new Map()
  for (const s of pack.skills ?? []) {
    const resources = s.resources ?? []
    skills.set(s.name, {
      id: s.name,
      dir: s.dir || s.name,
      layer: 'bundled',
      layerZh: '插件自带',
      title: s.title || s.name,
      description: s.description || '',
      zh: s.zh || '',
      cat: s.cat || 'tooling',
      viz: [],
      tags: s.tags || [],
      weight: s.weight ?? 2,
      bytes: (s.content || '').length,
      readable: true,
      content: s.content || '',
      resources,
      path: '',
      hasScripts: resources.some((r) => r.startsWith('scripts/')),
      hasReferences: resources.some((r) => r.startsWith('references/')),
      /** 有本地目录时用它读附属资源 */
      localPath: '',
      localDir: '',
    })
  }

  // 本地目录里多出来的技能（用户后续自己加的）也列出来。
  // 注意用「包里的技能名 **和** 源目录名」双重去重：有 24 个技能的目录名是下划线写法、
  // 注册名是 kebab-case（alphafold_database_fetch_and_analyze → alphafold-database-...），
  // 只按名字比对会把它们当成两个技能，清单里凭空多出 24 条。
  const packNames = new Set()
  const packDirs = new Set()
  for (const s of pack.skills ?? []) {
    packNames.add(s.name)
    if (s.dir) packDirs.add(s.dir)
  }
  let localCount = 0
  const local = await buildSkillCatalog(config).catch(() => ({ skills: [] }))
  for (const s of local.skills ?? []) {
    const known = packNames.has(s.id) || packDirs.has(s.id) || packDirs.has(s.dir)
    if (known) {
      // 本机有这个技能的目录：记下来，点开详情时用它读 scripts/references
      const hit = skills.get(s.id) ?? [...skills.values()].find((x) => x.dir === s.id || x.dir === s.dir)
      if (hit && s.path) {
        hit.localPath = s.path
        hit.localDir = s.dir
      }
      continue
    }
    localCount += 1
    skills.set(s.id, { ...s, layer: 'local', layerZh: '本地目录', content: '', resources: [] })
  }

  const list = [...skills.values()]
  return {
    version: 2,
    packError: pack.error ?? '',
    snapshot: {
      generatedAt: pack.generatedAt ?? '',
      sources: pack.builtFrom ?? [],
      note: pack.note ?? '',
      stats: pack.stats ?? null,
    },
    portable: true,
    categories: taxonomy.categories ?? pack.categories ?? [],
    layers: [
      { id: 'bundled', zh: '插件自带' },
      { id: 'local', zh: '本地目录' },
    ],
    counts: {
      total: list.length,
      bundled: list.filter((s) => s.layer === 'bundled').length,
      local: localCount,
      readable: list.filter((s) => s.content || s.readable).length,
    },
    skills: list,
  }
}

/**
 * 把技能注册进 DSH 的技能系统 —— 「对方装上就能用」就是这一步实现的。
 *
 * 两类都注册：
 *   · `bundled`：随插件分发的那些，正文已在内存里；
 *   · `local`：配了 skillsDirs 时目录里**多出来**的技能（用户后来自己丢进去的），
 *     正文按需从磁盘读一次，所以这个函数是 async。
 *
 * 注册是同步的、borrowed；同名冲突由 DSH 处理成 first-wins + 警告，本机已有
 * .dsh/skills 时它们的优先级更高（project 层压过 runtime 层），行为正确。
 */
async function registerSkills(ctx, catalog) {
  const skills = ctx.get ? ctx.get('skills') : undefined
  if (!skills || typeof skills.register !== 'function') {
    return { registered: 0, bundled: 0, local: 0, reason: 'skills 服务不可用（这一版 DSH 没有 ctx.skills）' }
  }
  let bundled = 0
  let local = 0
  const failures = []
  /** 成功注册的名字，供 /health 按名字向技能系统核对 */
  const done = []
  for (const s of catalog.skills) {
    if (s.layer !== 'bundled' && s.layer !== 'local') continue
    let content = s.content || ''
    if (!content && s.path) {
      try {
        content = await readFile(s.path, 'utf8')
      } catch (e) {
        failures.push(`${s.id}: 读不到正文 ${e?.message ?? e}`)
        continue
      }
    }
    if (!content) continue
    try {
      skills.register({
        name: s.id,
        description: (s.description || s.zh || s.id).slice(0, 900),
        content,
        // 自带的标 'bundled'（SkillSource 里的合法取值）；本地目录里的算 'custom'
        source: s.layer === 'bundled' ? 'bundled' : 'custom',
        resourceBase: (s.localDir || (s.layer === 'local' ? s.dir : ''))
          ? { kind: 'directory', path: s.localDir || s.dir }
          : {
            kind: 'opaque',
            description: '来自插件自带的技能包；scripts/references 等附属资源未随包分发，需要时请在源技能目录获取',
          },
        invocation: { modelInvocable: true, userInvocable: true },
      })
      if (s.layer === 'bundled') bundled += 1
      else local += 1
      done.push(s.id)
    } catch (e) {
      failures.push(`${s.id}: ${e?.message ?? e}`)
    }
  }
  return { registered: bundled + local, bundled, local, failures, done }
}

/**
 * 问技能系统自己一句：现在认得多少个来自本插件的技能。
 *
 * 这是「装上就能用」的**可自证证据** —— 换任何一台机器，打开 /health 就能看到
 * 实际注册进去的数量，而不是只能相信插件自己的计数。
 *
 * 按**名字**核对，不按 provider 字段：DSH 的 provider 取值由注册方式决定
 * （用 register 进来的通常是 'runtime'，不是插件名），拿插件名去比会永远是 0。
 */
async function probeSkillRegistry(ctx, mine) {
  try {
    const registry = ctx.get ? ctx.get('skills') : undefined
    if (!registry || typeof registry.list !== 'function') return { error: '技能系统不支持 list()' }
    const all = await registry.list({})
    const names = mine instanceof Set ? mine : new Set(mine ?? [])
    return {
      total: all.length,
      bundled: all.filter((s) => s.source === 'bundled').length,
      custom: all.filter((s) => s.source === 'custom').length,
      /** 本插件注册的技能里，有多少真的出现在技能系统返回的表里 */
      ours: all.filter((s) => names.has(s.name)).length,
      oursExpected: names.size,
    }
  } catch (e) {
    return { error: e?.message ?? String(e) }
  }
}

// ---------------------------------------------------------------------------
// 可视化状态（唯一真源：state/current.json）
// ---------------------------------------------------------------------------

class VizState {
  constructor(config) {
    this.config = config
    this.file = join(config.stateDir, 'current.json')
    this.memory = null
    this.rev = 0
  }

  async ensure() {
    await mkdir(this.config.stateDir, { recursive: true }).catch(() => {})
  }

  /** 写入一份可视化文档；返回它的版本号。 */
  async put(doc) {
    await this.ensure()
    const payload = JSON.stringify({ ts: Date.now(), doc })
    this.memory = payload
    this.rev = Date.now()
    if (payload.length <= this.config.maxStateBytes) {
      await writeFile(this.file, payload, 'utf8').catch(() => {})
    }
    return this.rev
  }

  /** 清空（close）：写一个空文档，不删文件，避免外部写入撞上不存在的路径。 */
  async clear() {
    return this.put({ kind: 'empty', title: '（已清空）' })
  }

  /** 读当前文档。以文件为准（外部脚本也能推图），文件缺失时退回内存。 */
  async get() {
    try {
      const info = await stat(this.file)
      const rev = Math.round(info.mtimeMs)
      const payload = await readFile(this.file, 'utf8')
      return { rev, payload }
    } catch {
      if (this.memory) return { rev: this.rev, payload: this.memory }
      return { rev: 0, payload: null }
    }
  }
}

// ---------------------------------------------------------------------------
// 结构来源解析
// ---------------------------------------------------------------------------

const PDB_ID = /^[0-9][A-Za-z0-9]{3}$/

/** 在配置的根目录下按文件名递归找一个结构文件（最多两层的常见布局）。 */
async function findLocalStructure(source, config) {
  const direct = resolve(source)
  if (existsSync(direct)) return direct
  const roots = config.structureRoots.length ? config.structureRoots : [process.cwd()]
  for (const root of roots) {
    const candidate = resolve(root, source)
    if (existsSync(candidate)) return candidate
    // 在根目录下浅层搜索同名文件（最多 3 层，跳过 .venv/node_modules 之类的大目录）
    const found = await searchFile(root, basename(source), 3, new Set(['node_modules', '.venv-skills', '.git', 'PDF']))
    if (found) return found
  }
  return null
}

async function searchFile(dir, target, depth, skip) {
  if (depth < 0) return null
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skip.has(entry.name) || entry.name.startsWith('.')) continue
      const hit = await searchFile(join(dir, entry.name), target, depth - 1, skip)
      if (hit) return hit
    } else if (entry.name.toLowerCase() === target.toLowerCase()) {
      return join(dir, entry.name)
    }
  }
  return null
}

/**
 * 取得结构文本。
 * source 可以是：本地路径（绝对/相对）、4 字符 PDB ID、http(s) URL。
 */
async function loadStructureText(source, config) {
  const text = String(source ?? '').trim()
  if (!text) throw new Error('source 不能为空：给本地 PDB/mmCIF 路径、4 位 PDB ID，或 http(s) 链接')
  if (/^https?:\/\//i.test(text)) {
    const res = await fetch(text)
    if (!res.ok) throw new Error(`下载失败：${res.status} ${res.statusText}（${text}）`)
    const body = await res.text()
    return { text: body, format: text.toLowerCase().endsWith('.cif') || text.toLowerCase().includes('mmcif') ? 'mmcif' : 'pdb', sourceId: '', sourceUrl: text, path: text }
  }
  if (PDB_ID.test(text)) {
    for (const ext of ['pdb', 'cif']) {
      const url = `${config.rcsb}/${text.toUpperCase()}.${ext}`
      try {
        const res = await fetch(url)
        if (res.ok) {
          const body = await res.text()
          if (body.length > 200) {
            return { text: body, format: ext === 'cif' ? 'mmcif' : 'pdb', sourceId: text.toUpperCase(), sourceUrl: url, path: url }
          }
        }
      } catch {
        // 换下一个扩展名
      }
    }
    throw new Error(`从 RCSB 下载 ${text.toUpperCase()} 失败：检查网络，或改为提供本地文件路径`)
  }
  const local = await findLocalStructure(text, config)
  if (!local) throw new Error(`找不到结构文件：${text}（已尝试绝对路径、structureRoots 下的相对路径与同名浅层搜索）`)
  const body = await readFile(local, 'utf8')
  const ext = extname(local).toLowerCase()
  return {
    text: body,
    format: ext === '.cif' || ext === '.mmcif' ? 'mmcif' : 'pdb',
    sourceId: basename(local, ext),
    sourceUrl: '',
    path: local,
  }
}

// ---------------------------------------------------------------------------
// 图表构造
// ---------------------------------------------------------------------------

const PALETTE = [
  '#4c9aff', '#f2a33c', '#5ac8a8', '#e56b6f', '#a78bfa',
  '#f4d35e', '#4dd0e1', '#f28e2b', '#8bc34a', '#e15759',
]

const color = (i) => PALETTE[i % PALETTE.length]

/** 在给定区间上采样一条曲线，返回 [[x,y], ...]。 */
function sampleCurve(fn, from, to, steps = 240) {
  const pts = []
  for (let i = 0; i <= steps; i += 1) {
    const x = from + ((to - from) * i) / steps
    pts.push([x, fn(x)])
  }
  return pts
}

/** 从直方图得到一个合适的纵轴上限。 */
function histTop(hist, fit) {
  let top = 0
  for (const d of hist.density) top = Math.max(top, d)
  if (fit) for (const p of fit) top = Math.max(top, p[1])
  return top * 1.12
}

/**
 * 生成「生存分析」图组：KM 阶梯曲线 + log-rank 检验。
 *
 * 输入 survivalGroups: [{ label, times: number[], events: 0|1[] }]。
 * 删失（events=0）必须给 —— 只给事件时间会把「随访中」当成「已死亡」，生存率算低。
 */
function buildSurvivalPanels(opts = {}) {
  const groups = (opts.survivalGroups || []).filter((g) => g && Array.isArray(g.times) && g.times.length)
  if (groups.length === 0) {
    throw new Error('survival 需要 survivalGroups：[{ label, times: [天数…], events: [1/0…] }]，events 1=事件发生、0=删失')
  }
  const km = N.kaplanMeier(groups)
  const lr = N.logRankTest(groups)
  const panel = {
    kind: 'survival',
    title: opts.title || 'Kaplan-Meier 生存曲线',
    groups: km,
    logRank: lr,
    showCensor: opts.showCensor !== false,
    xLabel: opts.xLabel || '时间',
    yLabel: opts.yLabel || '生存率',
  }
  if (lr) panel.caption = `log-rank 检验：χ² = ${N.fmt(lr.chi2, 3)}，df = ${lr.df}，${N.fmtP(lr.p)}`
  const meds = km.map((k) => `${k.label} 中位 ${k.median === null ? '未达到' : N.fmt(k.median, 1)}`).join('；')
  return {
    panels: [panel],
    result: { median: km.map((k) => k.median), events: km.map((k) => k.events), censored: km.map((k) => k.censored), logRank: lr },
    table: {
      columns: ['组', 'n', '事件数', '删失数', '中位生存期'],
      rows: km.map((k) => [k.label, k.n, k.events, k.censored, k.median === null ? '未达到' : N.fmt(k.median, 2)]),
    },
    summaryLine: `Kaplan-Meier：${meds}` + (lr
      ? `；log-rank χ² = ${N.fmt(lr.chi2, 3)}，${N.fmtP(lr.p)}`
      : '；log-rank 需要至少两组且有事件'),
  }
}

/**
 * 生成「ROC」图组：一条或多条曲线 + AUC。
 *
 * 输入 rocCurves: [{ label, labels: 0|1[], scores: number[] }]。
 * 打分方向约定：**越大越倾向阳性** —— 反了曲线会跑到对角线下方（AUC < 0.5），
 * 这时下面会明确提示，而不是让人自己猜。
 */
function buildRocPanels(opts = {}) {
  const raw = (opts.rocCurves || []).filter((c) => c && Array.isArray(c.labels) && Array.isArray(c.scores))
  if (raw.length === 0) {
    throw new Error('roc 需要 rocCurves：[{ label, labels: [1/0…], scores: [打分…] }]（打分越大越倾向阳性）')
  }
  const curves = []
  const warnings = []
  for (const c of raw) {
    const r = N.rocCurve(c.labels, c.scores)
    if (!r) {
      warnings.push(`${c.label || '曲线'}：阳性或阴性样本为空，已跳过`)
      continue
    }
    curves.push({ label: c.label || 'ROC', points: r.points, auc: r.auc, best: r.best })
    if (r.auc < 0.5) warnings.push(`${c.label || '曲线'} 的 AUC < 0.5，打分方向可能反了（约定越大越倾向阳性）`)
    if (warnings.length) break
  }
  if (curves.length === 0) throw new Error('roc：没有一条曲线能算出来（检查 labels 是否同时含 0 和 1）')
  const panel = {
    kind: 'roc',
    title: opts.title || 'ROC 曲线',
    curves,
    xLabel: opts.xLabel || '假阳性率 (1 − 特异度)',
    yLabel: opts.yLabel || '真阳性率 (灵敏度)',
  }
  const aucLine = curves.map((c) => `${c.label} AUC = ${N.fmt(c.auc, 3)}`).join('；')
  return {
    panels: [panel],
    result: { auc: curves.map((c) => c.auc), best: curves.map((c) => c.best) },
    table: {
      columns: ['曲线', 'AUC', '最佳切点', '该点灵敏度', '该点特异度'],
      rows: curves.map((c) => [c.label, N.fmt(c.auc, 4),
        c.best ? N.fmt(c.best.threshold, 4) : '', c.best ? N.fmt(c.best.tpr, 3) : '',
        c.best ? N.fmt(1 - c.best.fpr, 3) : '']),
    },
    summaryLine: aucLine + (warnings.length ? `。注意：${warnings.join('；')}` : ''),
  }
}

/** 生成「正态分布」图组。 */
function buildNormalPanels(opts = {}) {
  const values = nums(opts.values)
  const fitted = values.length >= 3 ? N.describe(values) : null
  const mu = Number.isFinite(opts.mu) ? opts.mu : (fitted ? fitted.mean : 0)
  const sigma = Number.isFinite(opts.sigma) && opts.sigma > 0 ? opts.sigma : (fitted && fitted.sd > 0 ? fitted.sd : 1)
  const from = mu - 4 * sigma
  const to = mu + 4 * sigma
  const pdf = sampleCurve((x) => N.normalPdf(x, mu, sigma), from, to, 320)
  const cdf = sampleCurve((x) => N.normalCdf(x, mu, sigma), from, to, 320)

  const bands = [1, 2, 3]
  const layers = []
  // ±3σ / ±2σ / ±1σ 由外向内叠着画，颜色逐层加深
  const shade = (k, alpha) => [{
    type: 'area',
    pts: sampleCurve((x) => N.normalPdf(x, mu, sigma), mu - k * sigma, mu + k * sigma, 120),
    color: `rgba(76,154,255,${alpha})`,
    baseline: 0,
  }]
  layers.push(...shade(3, 0.10), ...shade(2, 0.18), ...shade(1, 0.28))
  layers.push({ type: 'line', pts: pdf, color: '#4c9aff', width: 2.2 })
  layers.push({ type: 'vline', x: mu, color: '#e6edf3', dash: [5, 4], label: `μ = ${N.fmt(mu, 3)}` })
  void bands
  for (const k of [1, 2, 3]) {
    layers.push({
      type: 'text',
      x: mu + k * sigma,
      y: N.normalPdf(mu + k * sigma, mu, sigma) * 0.45,
      text: `${k}σ`,
      color: '#8fa3b8',
      size: 11,
    })
  }
  const ci = 1.96
  const panels = [
    {
      kind: 'xy',
      title: '正态分布曲线',
      xLabel: opts.xLabel ?? 'x',
      yLabel: '概率密度',
      layers,
      caption:
        `μ = ${N.fmt(mu, 4)}，σ = ${N.fmt(sigma, 4)}；` +
        `阴影区 68.27% / 95.45% / 99.73% 分别落在 ±1σ / ±2σ / ±3σ 内；` +
        `95% 中心区间 = [${N.fmt(mu - ci * sigma, 4)}, ${N.fmt(mu + ci * sigma, 4)}]`,
      legend: [
        { label: '±1σ 68.3%', color: 'rgba(76,154,255,0.55)' },
        { label: '±2σ 95.5%', color: 'rgba(76,154,255,0.35)' },
        { label: '±3σ 99.7%', color: 'rgba(76,154,255,0.20)' },
      ],
    },
    {
      kind: 'xy',
      title: '累积分布函数 Φ',
      xLabel: opts.xLabel ?? 'x',
      yLabel: '累积概率',
      yDomain: [0, 1],
      layers: [
        { type: 'hline', y: 0.5, color: '#8fa3b8', dash: [4, 4] },
        { type: 'line', pts: cdf, color: '#5ac8a8', width: 2.2 },
        { type: 'vline', x: mu, color: '#e6edf3', dash: [5, 4], label: 'μ' },
        { type: 'points', pts: [[mu - ci * sigma, 0.025], [mu + ci * sigma, 0.975]], color: '#f2a33c', r: 4 },
        {
          type: 'text',
          x: mu + ci * sigma,
          y: 0.975,
          text: '97.5%',
          color: '#f2a33c',
          size: 10.5,
          align: 'right',
        },
        {
          type: 'text',
          x: mu - ci * sigma,
          y: 0.025,
          text: '2.5%',
          color: '#f2a33c',
          size: 10.5,
          align: 'left',
        },
      ],
      caption: '双侧 95% 中心区间对应 Φ = 0.025 与 0.975 两个分位点。',
    },
  ]

  if (fitted) {
    const hist = N.histogram(values, opts.bins)
    const fitPts = sampleCurve((x) => N.normalPdf(x, fitted.mean, fitted.sd), hist.lo, hist.hi, 160)
    const sw = N.shapiroWilk(values)
    panels.push({
      kind: 'hist',
      title: '实测数据直方图 + 拟合正态',
      xLabel: opts.xLabel ?? '数值',
      yLabel: '密度',
      yDomain: [0, histTop(hist, fitPts)],
      layers: [
        {
          type: 'hist',
          bins: hist.edges.slice(0, -1).map((x0, i) => ({
            x0,
            x1: hist.edges[i + 1],
            density: hist.density[i],
            count: hist.counts[i],
          })),
          color: 'rgba(90,200,168,0.55)',
        },
        { type: 'line', pts: fitPts, color: '#f2a33c', width: 2 },
        { type: 'vline', x: fitted.mean, color: '#e6edf3', dash: [5, 4], label: '均值' },
      ],
      caption:
        `n = ${fitted.n}，均值 ${N.fmt(fitted.mean, 3)}，SD ${N.fmt(fitted.sd, 3)}；` +
        (Number.isFinite(sw.p)
          ? `Shapiro-Wilk W = ${N.fmt(sw.w, 4)}，${N.fmtP(sw.p)}${sw.p < 0.05 ? '（偏离正态）' : '（未见明显偏离正态）'}`
          : sw.note),
    })
    // Q-Q 图
    const sorted = [...values].sort((a, b) => a - b)
    const qqPts = sorted.map((v, i) => {
      const p = (i + 1 - 0.375) / (sorted.length + 0.25)
      return [N.normalInv(p, fitted.mean, fitted.sd), v]
    })
    const lo = Math.min(qqPts[0][0], qqPts[0][1])
    const hi = Math.max(qqPts[qqPts.length - 1][0], qqPts[qqPts.length - 1][1])
    panels.push({
      kind: 'qq',
      title: '正态 Q-Q 图',
      xLabel: '理论分位数（正态）',
      yLabel: '样本分位数',
      xDomain: [lo, hi],
      yDomain: [lo, hi],
      layers: [
        { type: 'line', pts: [[lo, lo], [hi, hi]], color: '#8fa3b8', width: 1.4, dash: [5, 4] },
        { type: 'points', pts: qqPts, color: '#4c9aff', r: 3 },
      ],
      caption: '点越贴近对角线越接近正态；两端明显外扩说明尾部偏重。',
    })
  }

  return {
    panels: panels.slice(0, opts.maxPanels ?? 4),
    table: fitted
      ? {
        title: '描述统计',
        columns: ['n', '均值', '标准差', '标准误', '中位数', 'Q1', 'Q3', '偏度', '峰度'],
        rows: [[
          fitted.n, N.fmt(fitted.mean, 4), N.fmt(fitted.sd, 4), N.fmt(fitted.se, 4),
          N.fmt(fitted.median, 4), N.fmt(fitted.q1, 4), N.fmt(fitted.q3, 4),
          N.fmt(fitted.skew, 3), N.fmt(fitted.kurtosis, 3),
        ]],
      }
      : null,
  }
}

/** 生成「t 检验」图组。 */
function buildTTestPanels(opts = {}) {
  const groups = normaliseGroups(opts)
  const oneSample = groups.length < 2
  const result = oneSample
    ? N.tTest(groups[0]?.values ?? nums(opts.values), undefined, {
      mu: Number.isFinite(opts.mu) ? opts.mu : 0,
      alternative: opts.alternative ?? 'two-sided',
      labelA: groups[0]?.label ?? '样本',
    })
    : N.tTest(groups[0].values, groups[1].values, {
      welch: opts.welch !== false,
      paired: opts.paired === true,
      alternative: opts.alternative ?? 'two-sided',
      labelA: groups[0].label,
      labelB: groups[1].label,
    })

  const df = result.df
  const tSpan = Math.max(4, Math.abs(result.t) * 1.35, N.tInv(0.999, df))
  const tcrit = N.tInv(0.975, df)
  const tail = opts.alternative ?? 'two-sided'
  const density = sampleCurve((x) => N.tPdf(x, df), -tSpan, tSpan, 320)
  const layers = []
  if (tail === 'two-sided') {
    layers.push({ type: 'area', pts: sampleCurve((x) => N.tPdf(x, df), -tSpan, -tcrit, 120), color: 'rgba(229,107,111,0.35)' })
    layers.push({ type: 'area', pts: sampleCurve((x) => N.tPdf(x, df), tcrit, tSpan, 120), color: 'rgba(229,107,111,0.35)' })
  } else if (tail === 'greater') {
    layers.push({ type: 'area', pts: sampleCurve((x) => N.tPdf(x, df), tcrit, tSpan, 120), color: 'rgba(229,107,111,0.35)' })
  } else {
    layers.push({ type: 'area', pts: sampleCurve((x) => N.tPdf(x, df), -tSpan, -tcrit, 120), color: 'rgba(229,107,111,0.35)' })
  }
  layers.push({ type: 'line', pts: density, color: '#a78bfa', width: 2.2 })
  layers.push({ type: 'vline', x: 0, color: '#8fa3b8', dash: [4, 4] })
  layers.push({ type: 'vline', x: result.t, color: '#f4d35e', width: 2, label: `t = ${N.fmt(result.t, 3)}` })
  if (tail === 'two-sided') {
    layers.push({ type: 'vline', x: -tcrit, color: '#e56b6f', dash: [4, 3], label: `−t₀.₉₇₅ = ${N.fmt(-tcrit, 3)}` })
    layers.push({ type: 'vline', x: tcrit, color: '#e56b6f', dash: [4, 3], label: `t₀.₉₇₅ = ${N.fmt(tcrit, 3)}` })
  }
  const panels = [{
    kind: 'xy',
    title: 't 分布与观测统计量',
    xLabel: 't',
    yLabel: '概率密度',
    layers,
    caption:
      `${result.testName}：t = ${N.fmt(result.t, 4)}，df = ${N.fmt(df, 2)}，${N.fmtP(result.p)}；` +
      `红色阴影为拒绝域（α = 0.05${tail === 'two-sided' ? '，双尾' : tail === 'greater' ? '，单尾 >' : '，单尾 <'}）。`,
    legend: [{ label: '拒绝域', color: 'rgba(229,107,111,0.6)' }, { label: 't 分布', color: '#a78bfa' }],
  }]

  const summary = summaryOf(result)

  if (!oneSample) {
    const a = result.groups[0]
    const b = result.groups[1]
    const pairedNote = result.kind === 'paired'
    const boxLayer = {
      type: 'boxes',
      items: [a, b].map((g, i) => ({
        x: i,
        lo: g.min,
        q1: g.q1,
        med: g.median,
        q3: g.q3,
        hi: g.max,
        color: color(i),
        // 组名已经在分类轴上，这里只写 n（两边都写会叠在一起）
        label: `n=${g.n}`,
      })),
      width: 0.42,
    }
    const pointLayers = pairedNote
      ? [{
        type: 'points',
        pts: (result.pairs?.a ?? []).map((v, i) => [0, v]).concat((result.pairs?.b ?? []).map((v) => [1, v])),
        color: '#8fa3b8',
        r: 3,
        opacity: 0.75,
      }]
      : [
        { type: 'points', pts: jitterPoints(groups[0].values, 0), color: color(0), r: 2.6, opacity: 0.75 },
        { type: 'points', pts: jitterPoints(groups[1].values, 1), color: color(1), r: 2.6, opacity: 0.75 },
      ]
    const meanPts = [
      { type: 'points', pts: [[0, a.mean]], color: '#ffffff', r: 4 },
      { type: 'points', pts: [[1, b.mean]], color: '#ffffff', r: 4 },
    ]
    const errLayer = {
      type: 'errorbars',
      items: [
        { x: 0, y: a.mean, lo: a.ci[0], hi: a.ci[1], color: '#ffffff' },
        { x: 1, y: b.mean, lo: b.ci[0], hi: b.ci[1], color: '#ffffff' },
      ],
    }
    panels.push({
      kind: 'boxes',
      title: pairedNote ? '配对样本分布（白点=均值，竖线=95%CI）' : `两组分布对比（白点=均值，竖线=95%CI）`,
      yLabel: opts.yLabel ?? '数值',
      xTickLabels: [a.label, b.label],
      layers: [boxLayer, ...pointLayers, errLayer, ...meanPts],
      caption:
        pairedNote
          ? `配对差值：均值 ${N.fmt(result.meanDiff, 4)}，95%CI [${N.fmt(result.ci[0], 4)}, ${N.fmt(result.ci[1], 4)}]`
          : `${a.label}: ${N.fmt(a.mean, 4)} ± ${N.fmt(a.sd, 4)} (n=${a.n})；` +
            `${b.label}: ${N.fmt(b.mean, 4)} ± ${N.fmt(b.sd, 4)} (n=${b.n})；` +
            `均值差 ${N.fmt(result.meanDiff, 4)}，95%CI [${N.fmt(result.ci[0], 4)}, ${N.fmt(result.ci[1], 4)}]`,
    })

    if (result.kind === 'paired' && result.pairs) {
      const diffs = result.pairs.diff
      const hist = N.histogram(diffs)
      const d = N.describe(diffs)
      const fit = sampleCurve((x) => N.normalPdf(x, d.mean, d.sd || 1), hist.lo, hist.hi, 120)
      panels.push({
        kind: 'hist',
        title: '配对差值分布（检验的对象是它是否为 0）',
        xLabel: '差值 (A − B)',
        yLabel: '密度',
        yDomain: [0, histTop(hist, fit)],
        layers: [
          {
            type: 'hist',
            bins: hist.edges.slice(0, -1).map((x0, i) => ({
              x0, x1: hist.edges[i + 1], density: hist.density[i], count: hist.counts[i],
            })),
            color: 'rgba(167,139,250,0.5)',
          },
          { type: 'line', pts: fit, color: '#f2a33c', width: 1.8 },
          { type: 'vline', x: 0, color: '#e56b6f', width: 2, dash: [5, 4], label: 'H₀: 差值为 0' },
          { type: 'vline', x: d.mean, color: '#5ac8a8', width: 2, label: `均值差 ${N.fmt(d.mean, 3)}` },
        ],
        caption: `n = ${d.n}，差值均值 ${N.fmt(d.mean, 4)}，SD ${N.fmt(d.sd, 4)}。`,
      })
    }

    // 效应量森林图（单项：x 轴无意义，关掉刻度只留数值轴）
    panels.push({
      kind: 'forest',
      title: '均值差与 95% 置信区间',
      yLabel: `${a.label} − ${b.label}（均值差）`,
      xDomain: [-1, 1],
      xTicks: [],
      layers: [
        {
          type: 'errorbars',
          items: [{ x: 0, y: result.meanDiff, lo: result.ci[0], hi: result.ci[1], color: '#4c9aff' }],
        },
        { type: 'points', pts: [[0, result.meanDiff]], color: '#4c9aff', r: 5 },
        { type: 'hline', y: 0, color: '#e56b6f', dash: [5, 4], label: '无差异' },
      ],
      caption:
        `Cohen's d = ${N.fmt(result.effectSize, 3)}；` +
        (result.varianceTest ? `方差齐性 F = ${N.fmt(result.varianceTest.f, 3)}，${N.fmtP(result.varianceTest.p)}` : ''),
    })
  }

  return { panels: panels.slice(0, opts.maxPanels ?? 4), table: summary, result }
}

/** 给散点加一点确定性横向抖动（避免同一 x 上重叠成一条线）。 */
function jitterPoints(values, x, width = 0.24) {
  const out = []
  const n = values?.length ?? 0
  for (let i = 0; i < n; i += 1) {
    const h = Math.abs(Math.sin((i + 1) * 12.9898 + x * 78.233) * 43758.5453) % 1
    out.push([x + (h - 0.5) * width, values[i]])
  }
  return out
}

/** 把 {groups:[{label,values}]} 或 {values:[]} 归一到分组数组。 */
function normaliseGroups(opts) {
  if (Array.isArray(opts.groups) && opts.groups.length > 0) {
    return opts.groups.map((g, i) => ({
      label: g.label ?? `组${i + 1}`,
      values: nums(g.values ?? g.data ?? g),
    }))
  }
  const flat = nums(opts.values)
  if (flat.length) return [{ label: opts.label ?? '样本', values: flat }]
  return []
}

/** 生成「方差分析」图组。 */
function buildAnovaPanels(opts = {}) {
  const groups = normaliseGroups(opts)
  if (groups.length < 2) throw new Error('ANOVA 至少需要 2 组数据（用 groups: [{label, values}, ...]）')
  const result = N.anovaOneWay(groups)
  const fSpan = Math.max(result.f * 1.5, N.fInv(0.995, result.df1, result.df2))
  const layers = [
    { type: 'area', pts: sampleCurve((x) => N.fPdf(x, result.df1, result.df2), result.fcrit, fSpan, 120), color: 'rgba(229,107,111,0.35)' },
    { type: 'line', pts: sampleCurve((x) => N.fPdf(x, result.df1, result.df2), 0, fSpan, 320), color: '#5ac8a8', width: 2.2 },
    { type: 'vline', x: result.fcrit, color: '#e56b6f', dash: [4, 3], label: `F₀.₉₅ = ${N.fmt(result.fcrit, 3)}` },
    { type: 'vline', x: result.f, color: '#f4d35e', width: 2, label: `F = ${N.fmt(result.f, 3)}` },
  ]
  const panels = [{
    kind: 'xy',
    title: 'F 分布与观测 F 值',
    xLabel: 'F',
    yLabel: '概率密度',
    layers,
    caption:
      `单因素方差分析：F(${result.df1}, ${result.df2}) = ${N.fmt(result.f, 4)}，${N.fmtP(result.p)}；` +
      `η² = ${N.fmt(result.eta2, 4)}（组间变异占比），ω² = ${N.fmt(result.omega2, 4)}。`,
    legend: [{ label: '拒绝域', color: 'rgba(229,107,111,0.6)' }, { label: 'F 分布', color: '#5ac8a8' }],
  }]

  const labels = result.groups.map((g) => g.label)
  panels.push({
    kind: 'boxes',
    title: '各组分布（白点=均值，竖线=95%CI）',
    yLabel: opts.yLabel ?? '数值',
    xTickLabels: labels,
    layers: [
      {
        type: 'boxes',
        width: 0.45,
        items: result.groups.map((g, i) => ({
          x: i, lo: g.min, q1: g.q1, med: g.median, q3: g.q3, hi: g.max, color: color(i), label: `n=${g.n}`,
        })),
      },
      ...result.groups.map((g, i) => ({
        type: 'points',
        pts: jitterPoints(groups[i].values, i, 0.3),
        color: color(i),
        r: 2.4,
        opacity: 0.7,
      })),
      {
        type: 'errorbars',
        items: result.groups.map((g, i) => ({ x: i, y: g.mean, lo: g.ci[0], hi: g.ci[1], color: '#ffffff' })),
      },
      { type: 'points', pts: result.groups.map((g, i) => [i, g.mean]), color: '#ffffff', r: 4 },
    ],
    caption: result.groups
      .map((g) => `${g.label}: ${N.fmt(g.mean, 3)} ± ${N.fmt(g.sd, 3)} (n=${g.n})`)
      .join('；'),
  })

  if (result.posthoc.length) {
    const items = result.posthoc.map((r, i) => ({
      x: i,
      y: r.meanDiff,
      lo: r.ci[0],
      hi: r.ci[1],
      color: (r.pHolm ?? 1) < 0.05 ? '#f2a33c' : '#6b7a8c',
    }))
    panels.push({
      kind: 'forest',
      title: '事后两两比较（均值差与 95%CI）',
      xLabel: '均值差',
      xTickLabels: result.posthoc.map((r) => `${r.a} − ${r.b}`),
      layers: [
        { type: 'errorbars', items },
        { type: 'points', pts: items.map((it) => [it.x, it.y]), color: '#4c9aff', r: 4 },
        { type: 'vline', x: 0, color: '#e56b6f', dash: [5, 4], label: '无差异' },
      ],
      caption:
        `${result.posthocMethod}；橙色表示校正后 p < 0.05。` +
        result.posthoc
          .slice(0, 6)
          .map((r) => `${r.a} vs ${r.b}: Δ=${N.fmt(r.meanDiff, 3)}, ${N.fmtP(r.pHolm)}, d=${N.fmt(r.d, 2)}`)
          .join('；'),
    })
  }

  return { panels: panels.slice(0, opts.maxPanels ?? 4), table: summaryOf(result), result }
}

/** 生成「卡方检验」图组。 */
function buildChi2Panels(opts = {}) {
  const table = opts.table
  if (!Array.isArray(table)) throw new Error('卡方检验需要 table：二维计数数组，如 [[18,7],[6,19]]')
  const result = N.chiSquareTest(table, { yates: opts.yates })
  const rows = table.length
  const cols = table[0].length
  const rowLabels = opts.rowLabels ?? table.map((_, i) => `行${i + 1}`)
  const colLabels = opts.colLabels ?? Array.from({ length: cols }, (_, j) => `列${j + 1}`)
  const items = []
  let x = 0
  for (let i = 0; i < rows; i += 1) {
    for (let j = 0; j < cols; j += 1) {
      items.push({ x, y: table[i][j], color: color(j), label: `${rowLabels[i]}/${colLabels[j]}` })
      x += 1
    }
  }
  const chiSpan = Math.max(result.chi2 * 1.5, N.chi2Inv(0.995, result.df))
  const panels = [
    {
      kind: 'bars',
      title: '观察频数（按列着色）',
      yLabel: '频数',
      xTickLabels: items.map((it) => it.label),
      layers: [
        { type: 'bars', items, width: 0.7 },
        {
          type: 'points',
          pts: result.expected.flatMap((row, i) => row.map((e, j) => [i * cols + j, e])),
          color: '#ffffff',
          r: 3,
          shape: 'diamond',
        },
      ],
      caption: `白菱形 = 理论期望频数。最小期望频数 ${N.fmt(result.minExpected, 2)}。`,
      legend: colLabels.map((l, j) => ({ label: l, color: color(j) })),
    },
    {
      kind: 'xy',
      title: '卡方分布与观测值',
      xLabel: 'χ²',
      yLabel: '概率密度',
      layers: [
        {
          type: 'area',
          pts: sampleCurve((x2) => N.chi2Pdf(x2, result.df), N.chi2Inv(0.95, result.df), chiSpan, 120),
          color: 'rgba(229,107,111,0.35)',
        },
        { type: 'line', pts: sampleCurve((x2) => N.chi2Pdf(x2, result.df), 0, chiSpan, 320), color: '#4dd0e1', width: 2.2 },
        { type: 'vline', x: N.chi2Inv(0.95, result.df), color: '#e56b6f', dash: [4, 3], label: `χ²₀.₉₅ = ${N.fmt(N.chi2Inv(0.95, result.df), 3)}` },
        { type: 'vline', x: result.chi2, color: '#f4d35e', width: 2, label: `χ² = ${N.fmt(result.chi2, 3)}` },
      ],
      caption:
        `${result.testName}：χ² = ${N.fmt(result.chi2, 4)}，df = ${result.df}，${N.fmtP(result.p)}；` +
        `Cramér's V = ${N.fmt(result.cramersV, 4)}${result.yates ? '（2×2 已做 Yates 连续性校正）' : ''}。` +
        (result.warn ? ` ⚠ ${result.warn}` : ''),
    },
  ]
  return { panels: panels.slice(0, opts.maxPanels ?? 4), table: summaryOf(result), result }
}

/** 生成「线性回归」图组。 */
function buildRegressionPanels(opts = {}) {
  const xs = nums(opts.x)
  const ys = nums(opts.y)
  if (xs.length !== ys.length) throw new Error(`x 与 y 长度必须一致（收到 ${xs.length} 与 ${ys.length}）`)
  const result = N.linearRegression(xs, ys)
  const fitPts = []
  const bandTop = []
  const bandBottom = []
  const steps = 80
  for (let i = 0; i <= steps; i += 1) {
    const x = result.xMin + ((result.xMax - result.xMin) * i) / steps
    const f = result.toFit(x)
    fitPts.push([x, f.y])
    bandTop.push([x, f.hi])
    bandBottom.push([x, f.lo])
  }
  const residuals = result.pairs.map(([x, y]) => [result.intercept + result.slope * x, y - (result.intercept + result.slope * x)])
  const panels = [
    {
      kind: 'scatter',
      title: '散点 + 最小二乘拟合 + 95% 置信带',
      xLabel: opts.xLabel ?? 'x',
      yLabel: opts.yLabel ?? 'y',
      layers: [
        { type: 'area', pts: bandTop.concat([...bandBottom].reverse()), color: 'rgba(76,154,255,0.16)' },
        { type: 'line', pts: fitPts, color: '#4c9aff', width: 2.2 },
        { type: 'points', pts: result.pairs, color: '#f2a33c', r: 3.2, opacity: 0.9 },
      ],
      caption:
        `y = ${N.fmt(result.intercept, 4)} + ${N.fmt(result.slope, 4)}·x；` +
        `R² = ${N.fmt(result.r2, 4)}，r = ${N.fmt(result.r, 4)}，${N.fmtP(result.p)}（n = ${result.n}）。` +
        `斜率 95%CI = [${N.fmt(result.slopeCi[0], 4)}, ${N.fmt(result.slopeCi[1], 4)}]。`,
    },
    {
      kind: 'scatter',
      title: '残差图（检查线性与等方差）',
      xLabel: '拟合值 ŷ',
      yLabel: '残差',
      layers: [
        { type: 'hline', y: 0, color: '#e56b6f', dash: [5, 4] },
        { type: 'points', pts: residuals, color: '#5ac8a8', r: 3 },
      ],
      caption: `残差标准差 ${N.fmt(result.seResid, 4)}；点应无趋势地散布在 0 线两侧。`,
    },
  ]
  return { panels: panels.slice(0, opts.maxPanels ?? 4), table: summaryOf(result), result }
}

/** 生成「功效 / 样本量」图组。 */
function buildPowerPanels(opts = {}) {
  const d = Number.isFinite(opts.d) ? opts.d : 0.5
  const alpha = Number.isFinite(opts.alpha) ? opts.alpha : 0.05
  const target = Number.isFinite(opts.power) ? opts.power : 0.8
  const pts = []
  for (let n = 2; n <= 200; n += 1) {
    pts.push([n, N.tTestPower(n, n, d, alpha)])
  }
  const need = N.sampleSizeTTest(d, target, alpha)
  const panels = [{
    kind: 'xy',
    title: `功效曲线（独立双样本 t 检验，d = ${d}，α = ${alpha}）`,
    xLabel: '每组样本量 n',
    yLabel: '功效 (1 − β)',
    yDomain: [0, 1.02],
    layers: [
      { type: 'hline', y: target, color: '#8fa3b8', dash: [5, 4], label: `目标功效 ${target}` },
      { type: 'hline', y: 0.8, color: 'rgba(143,163,184,0.4)', dash: [3, 4] },
      { type: 'line', pts, color: '#4c9aff', width: 2.2 },
      { type: 'vline', x: need.n1, color: '#5ac8a8', width: 2, label: `n = ${need.n1}` },
      { type: 'points', pts: [[need.n1, need.power]], color: '#5ac8a8', r: 5 },
    ],
    caption: `每组需 ${need.n1} 例（合计 ${need.total}），此时功效 ${N.fmt(need.power, 4)}。d = ${d} 属于${
      d < 0.2 ? '极小' : d < 0.5 ? '小' : d < 0.8 ? '中等' : '大'}效应。`,
  }]
  return {
    panels,
    table: {
      title: '样本量估算',
      columns: ['效应量 d', '每组 n', '合计', '达到功效', 'α'],
      rows: [[d, need.n1, need.total, N.fmt(need.power, 4), alpha]],
    },
    result: { kind: 'power', d, alpha, target, need },
  }
}

/** 生成「描述统计 + 直方图」图组。 */
function buildDescriptivePanels(opts = {}) {
  const groups = normaliseGroups(opts)
  if (groups.length === 0) throw new Error('至少需要一组 values')
  const panels = []
  panels.push({
    kind: 'boxes',
    title: groups.length > 1 ? '各组箱线图' : '箱线图',
    yLabel: opts.yLabel ?? '数值',
    xTickLabels: groups.map((g) => g.label),
    layers: [
      {
        type: 'boxes',
        width: 0.45,
        items: groups.map((g, i) => {
          const d = N.describe(g.values, { label: g.label })
          return { x: i, lo: d.min, q1: d.q1, med: d.median, q3: d.q3, hi: d.max, color: color(i), label: `n=${d.n}` }
        }),
      },
      ...groups.map((g, i) => ({ type: 'points', pts: jitterPoints(g.values, i, 0.3), color: color(i), r: 2.6, opacity: 0.7 })),
      {
        type: 'errorbars',
        items: groups.map((g, i) => {
          const d = N.describe(g.values)
          return { x: i, y: d.mean, lo: d.ci[0], hi: d.ci[1], color: '#ffffff' }
        }),
      },
    ],
    caption: groups
      .map((g) => {
        const d = N.describe(g.values, { label: g.label })
        return `${g.label}: n=${d.n}, 均值 ${N.fmt(d.mean, 4)}, SD ${N.fmt(d.sd, 4)}, 中位数 ${N.fmt(d.median, 4)}`
      })
      .join('；'),
  })
  const first = groups[0]
  const hist = N.histogram(first.values, opts.bins)
  const d0 = N.describe(first.values)
  const fit = sampleCurve((x) => N.normalPdf(x, d0.mean, d0.sd || 1), hist.lo, hist.hi, 120)
  panels.push({
    kind: 'hist',
    title: `${first.label} 的分布`,
    xLabel: opts.yLabel ?? '数值',
    yLabel: '密度',
    yDomain: [0, histTop(hist, fit)],
    layers: [
      {
        type: 'hist',
        bins: hist.edges.slice(0, -1).map((x0, i) => ({ x0, x1: hist.edges[i + 1], density: hist.density[i], count: hist.counts[i] })),
        color: 'rgba(76,154,255,0.5)',
      },
      { type: 'line', pts: fit, color: '#f2a33c', width: 1.8 },
    ],
    caption: `${hist.bins} 个分箱（Freedman-Diaconis 规则），橙色为正态拟合。`,
  })
  const table = {
    title: '描述统计',
    columns: ['组', 'n', '均值', 'SD', '标准误', '中位数', 'Q1', 'Q3', '最小值', '最大值', '95%CI'],
    rows: groups.map((g) => {
      const d = N.describe(g.values, { label: g.label })
      return [
        g.label, d.n, N.fmt(d.mean, 4), N.fmt(d.sd, 4), N.fmt(d.se, 4), N.fmt(d.median, 4),
        N.fmt(d.q1, 4), N.fmt(d.q3, 4), N.fmt(d.min, 4), N.fmt(d.max, 4),
        `[${N.fmt(d.ci[0], 3)}, ${N.fmt(d.ci[1], 3)}]`,
      ]
    }),
  }
  return { panels: panels.slice(0, opts.maxPanels ?? 4), table, result: null }
}

/** 通用 escape hatch：直接吃一套 panels（由 sci_viz_plot 使用）。 */
function buildRawPanels(opts = {}) {
  if (!Array.isArray(opts.panels)) throw new Error('需要 panels 数组')
  return { panels: opts.panels.slice(0, 6), table: opts.table ?? null, result: null }
}

/** 把检验结果压成一张表 + 一句摘要。 */
function summaryOf(result) {
  if (result.kind === 'anova') {
    return {
      title: '方差分析表',
      columns: ['来源', '平方和 SS', '自由度 df', '均方 MS', 'F', 'p'],
      rows: [
        ['组间', N.fmt(result.ssBetween, 4), result.df1, N.fmt(result.msBetween, 4), N.fmt(result.f, 4), N.fmt(result.p, 6)],
        ['组内', N.fmt(result.ssWithin, 4), result.df2, N.fmt(result.msWithin, 4), '', ''],
        ['总计', N.fmt(result.ssTotal, 4), result.df1 + result.df2, '', '', ''],
      ],
      note: `η² = ${N.fmt(result.eta2, 4)}；ω² = ${N.fmt(result.omega2, 4)}`,
    }
  }
  if (result.kind === 'chi2') {
    return {
      title: '卡方检验',
      columns: ['χ²', 'df', 'p', "Cramér's V", 'Yates'],
      rows: [[N.fmt(result.chi2, 4), result.df, N.fmt(result.p, 6), N.fmt(result.cramersV, 4), result.yates ? '是' : '否']],
      note: result.warn || undefined,
    }
  }
  if (result.kind === 'regression') {
    return {
      title: '回归系数',
      columns: ['项', '估计', '标准误', '95%CI', 't', 'p'],
      rows: [
        ['截距', N.fmt(result.intercept, 4), N.fmt(result.seIntercept, 4),
          `[${N.fmt(result.interceptCi[0], 3)}, ${N.fmt(result.interceptCi[1], 3)}]`, '', ''],
        ['斜率', N.fmt(result.slope, 4), N.fmt(result.seSlope, 4),
          `[${N.fmt(result.slopeCi[0], 3)}, ${N.fmt(result.slopeCi[1], 3)}]`, N.fmt(result.t, 4), N.fmt(result.p, 6)],
      ],
      note: `R² = ${N.fmt(result.r2, 4)}，n = ${result.n}`,
    }
  }
  if (result.kind === 'power') {
    return {
      title: '功效分析',
      columns: ['效应量 d', 'α', '目标功效', '每组 n', '合计'],
      rows: [[result.d, result.alpha, result.target, result.need.n1, result.need.total]],
    }
  }
  // t 检验族
  const rows = result.groups.map((g) => [g.label, g.n, N.fmt(g.mean, 4), N.fmt(g.sd, 4), N.fmt(g.se, 4)])
  return {
    title: result.testName,
    columns: ['组', 'n', '均值', 'SD', '标准误'],
    rows,
    note:
      `t = ${N.fmt(result.t, 4)}，df = ${N.fmt(result.df, 3)}，${N.fmtP(result.p)}；` +
      `均值差 ${N.fmt(result.meanDiff, 4)}，95%CI [${N.fmt(result.ci[0], 4)}, ${N.fmt(result.ci[1], 4)}]；` +
      `${result.effectName} = ${N.fmt(result.effectSize, 3)}`,
  }
}

/** 把统计结果压成一段给模型看的中文摘要。 */
function statsSummary(kind, built) {
  const r = built.result
  if (!r) return '已生成图表'
  if (kind === 'anova') {
    return `单因素方差分析：F(${r.df1}, ${r.df2}) = ${N.fmt(r.f, 4)}，${N.fmtP(r.p)}，η² = ${N.fmt(r.eta2, 4)}；` +
      `事后比较（${r.posthocMethod}）中 ${r.posthoc.filter((x) => (x.pHolm ?? 1) < 0.05).length}/${r.posthoc.length} 对达到 p < 0.05`
  }
  if (kind === 'chisq') {
    return `卡方检验：χ²(${r.df}) = ${N.fmt(r.chi2, 4)}，${N.fmtP(r.p)}，Cramér's V = ${N.fmt(r.cramersV, 4)}`
  }
  if (kind === 'regression') {
    return `线性回归：y = ${N.fmt(r.intercept, 4)} + ${N.fmt(r.slope, 4)}x，R² = ${N.fmt(r.r2, 4)}，${N.fmtP(r.p)}（n = ${r.n}）`
  }
  if (kind === 'power') {
    return `每组需 ${r.need.n1} 例（合计 ${r.need.total}）才能以 ${N.fmt(r.need.power, 3)} 的功效检出 d = ${r.d}`
  }
  if (kind === 'normal') {
    return `已绘制正态分布曲线与累积分布${built.table ? '，并附实测数据直方图与 Q-Q 图' : ''}`
  }
  if (kind === 'descriptives') {
    return `已绘制描述统计图（${built.panels.length} 个面板）`
  }
  if (kind === 'survival') {
    const lr = r.logRank
    const meds = r.median.map((m, i) => `${built.panels[0].groups[i].label} ${m === null ? '未达到' : N.fmt(m, 2)}`)
    return `Kaplan-Meier 生存分析（${r.median.length} 组）：log-rank χ² = ${N.fmt(lr.chi2, 4)}，df = ${lr.df}，`
      + `${N.fmtP(lr.p)}。各组中位生存期：${meds.join('，')}`
  }
  if (kind === 'roc') {
    return `ROC：${built.table.rows.map((row) => `${row[0]} AUC = ${row[1]}`).join('；')}`
      + `（${built.table.rows.length} 条曲线；AUC = 0.5 为无判别力）`
  }
  return `${r.testName}：t = ${N.fmt(r.t, 4)}，df = ${N.fmt(r.df, 3)}，${N.fmtP(r.p)}；` +
    `均值差 ${N.fmt(r.meanDiff, 4)}，95%CI [${N.fmt(r.ci[0], 4)}, ${N.fmt(r.ci[1], 4)}]，${r.effectName} = ${N.fmt(r.effectSize, 3)}`
}

// 注意：这里刻意没有 'raw'。曾经留过它，但 stats 的参数表 additionalProperties:false，
// 而 raw 需要的 panels 参数根本没声明 —— 那条分支永远走不通。自定义绘图交给 sci_viz_plot。
const STAT_KINDS = ['normal', 'ttest', 'anova', 'chisq', 'regression', 'power', 'descriptives',
  'survival', 'roc']

/** 通用 escape hatch 已移到 sci_viz_plot；这里不再保留 raw 分支。 */
function buildChart(kind, opts) {
  switch (kind) {
    case 'survival': return buildSurvivalPanels(opts)
    case 'roc': return buildRocPanels(opts)
    case 'normal': return buildNormalPanels(opts)
    case 'ttest': return buildTTestPanels(opts)
    case 'anova': return buildAnovaPanels(opts)
    case 'chisq': return buildChi2Panels(opts)
    case 'regression': return buildRegressionPanels(opts)
    case 'power': return buildPowerPanels(opts)
    case 'descriptives': return buildDescriptivePanels(opts)
    default: throw new Error(`不支持的 kind：${kind}（可用：${STAT_KINDS.join(' / ')}；自定义绘图请用 sci_viz_plot）`)
  }
}

// ---------------------------------------------------------------------------
// 工具（普通对象，不走 defineTool —— 见文件头说明）
// ---------------------------------------------------------------------------

const STRUCTURE_STYLES = ['cartoon', 'trace', 'ballstick', 'spacefill', 'ligand']
const COLOR_SCHEMES = ['chain', 'ss', 'bfactor', 'resname', 'rainbow', 'element']

/** 球类风格默认按元素着色（一条链的空间填充图全是一个颜色，什么也看不出来）。 */
const DEFAULT_COLOR_BY = {
  cartoon: 'chain',
  trace: 'chain',
  ballstick: 'element',
  spacefill: 'element',
  ligand: 'element',
}

/**
 * `sci_viz_structure` 的参数表。
 *
 * 提到模块层是为了让**面板上的「打开结构」走同一份定义** —— 用户在界面上输入路径、
 * 我调用工具，两条路必须能做同样的事、给同样的错误信息，否则「即用」就是句空话。
 */
const STRUCTURE_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['source'],
  properties: {
    source: {
      type: 'string',
      description: '本地路径（绝对或相对工作区）、4 位 PDB ID（如 1SJ0），或 http(s) 链接',
    },
    label: { type: 'string', description: '窗口标题（例如「KatG S315T 突变位点」）' },
    style: { type: 'string', enum: STRUCTURE_STYLES, description: '初始表现方式，默认 cartoon' },
    colorBy: { type: 'string', enum: COLOR_SCHEMES, description: '着色方案，默认 chain' },
    highlight: {
      type: 'array',
      items: { type: 'string' },
      description: '要高亮的残基，支持 "S315T" / "S315" / "315" / "A:315" 等写法',
    },
    termini: {
      type: 'boolean',
      description: '是否高亮每条链的 N 端与 C 端残基（绿 = N 端，紫 = C 端）。面板工具栏上有同名开关，用户可自行切换',
    },
    chains: {
      type: 'array',
      items: { type: 'string' },
      description: '只显示这些链（留空显示全部）',
    },
    focus: {
      type: 'array',
      items: { type: 'number' },
      description: '初始视角中心 [x, y, z]（Å），配合 highlight 把镜头对准突变位点',
    },
    note: { type: 'string', description: '显示在窗口里的一句注解' },
  },
}

/**
 * 结构任务的公共实现：加载 → 解析 → 编译 → 高亮 → 组装文档。
 * 工具与 HTTP 路由都调它（路由自己再 put）。
 * @returns {Promise<{doc: object, value: object}>}
 */
async function buildStructureDoc(args, config) {
  // 面板拖进来的文件是直接把文本塞进来的，不经过路径解析
  const loaded = args.text
    ? {
      text: args.text,
      format: args.format === 'mmcif' ? 'mmcif' : 'pdb',
      path: args.source || '(拖入的文件)',
      sourceId: '',
      sourceUrl: '',
    }
    : await loadStructureText(args.source, config)
  const parsed = parseStructure(loaded.text, loaded.format)
  const doc = compileStructure(parsed, {
    path: loaded.path,
    format: loaded.format,
    bytes: loaded.text.length,
    sourceId: loaded.sourceId,
    sourceUrl: loaded.sourceUrl,
    label: args.label,
  })
  const warnings = []
  if (doc.atoms.truncated > 0) warnings.push(`结构太大，已截断 ${doc.atoms.truncated} 个原子（上限 ${24000}）`)

  // 残基高亮：把各种写法解析成 (链, 残基号)
  const highlight = []
  for (const spec of args.highlight ?? []) {
    const site = parseSiteSpec(spec)
    if (!site) {
      warnings.push(`看不懂的位点写法「${spec}」，已忽略（可用 S315T / S315 / 315 / A:315）`)
      continue
    }
    const wanted = site.chain
    let hit = null
    for (const chain of doc.chains) {
      if (wanted && chain.id !== wanted) continue
      if (site.resSeq >= (chain.first ?? 0) && site.resSeq <= (chain.last ?? -1)) {
        hit = { chain: chain.id, resSeq: site.resSeq }
        break
      }
    }
    if (hit) {
      const label = `${site.wildtype ?? ''}${site.resSeq}${site.mutant ?? ''}`
      highlight.push({ ...hit, label, spec, role: 'site' })
    } else {
      warnings.push(`结构里没有找到残基 ${spec}`)
    }
  }
  // N 端 / C 端：宿主只标记「要不要」，具体把哪些残基染成什么颜色由浏览器半边算
  // （用户还能在工具栏上随时开关，不必再调一次工具）。
  const wantTermini = args.termini === true
  const terminusLine = wantTermini
    ? doc.chains
      .filter((c) => c.residueCount > 0 && c.first !== null)
      .slice(0, 8)
      .map((c) => `${c.id}: ${c.first}→${c.last}`)
      .join('，')
    : ''
  doc.highlight = highlight
  doc.view = {
    style: args.style ?? 'cartoon',
    colorBy: args.colorBy ?? DEFAULT_COLOR_BY[args.style ?? 'cartoon'] ?? 'chain',
    chains: args.chains ?? [],
    focus: Array.isArray(args.focus) && args.focus.length === 3 ? args.focus : null,
    termini: wantTermini,
    note: args.note ?? '',
  }
  doc.pushedAt = Date.now()
  /**
   * 由工具推来的文档要求浏览器半边**主动把面板翻出来**。
   * 用户在面板上有个「⇥ 自动跳转」开关，但那是给后台更新用的；「我刚做完一次分析」
   * 这种事应当直接把结果摆到他面前，所以这里单独标一个记号，watcher 见到就翻页。
   */
  doc.autoOpen = true

  const chainLine = doc.chains
    .filter((c) => c.residueCount > 0)
    .slice(0, 12)
    .map((c) => `${c.id}(${c.residueCount})`)
    .join(' ')
  const summary =
    `已在可视化窗口打开 ${doc.title}：${doc.stats.chains} 条链，${doc.stats.proteinResidues} 个蛋白质残基，` +
    `${doc.stats.atoms} 个原子` +
    (doc.source.resolution ? `，分辨率 ${doc.source.resolution} Å` : '') +
    (doc.stats.ssSource === 'geometry' ? '（二级结构由 Cα 几何推算，文件无注释）' : '') +
    (doc.ligands.length ? `；配体/辅因子：${doc.ligands.slice(0, 6).map((l) => `${l.name}×${l.copies}`).join('、')}` : '；未检出配体') +
    `。链与残基数：${chainLine}` +
    (highlight.length ? `。已高亮：${highlight.map((h) => h.label).join('、')}` : '') +
    (wantTermini ? `。已开启末端高亮：${terminusLine}` : '') +
    (warnings.length ? `。注意：${warnings.join('；')}` : '')

  return {
    doc,
    value: {
      ok: true,
      title: doc.title,
      summary,
      chains: doc.stats.chains,
      residues: doc.stats.proteinResidues,
      atoms: doc.stats.atoms,
      ligands: doc.ligands.slice(0, 20).map((l) => `${l.name}×${l.copies}`),
      highlighted: wantTermini
        ? highlight.map((h) => h.label).concat(doc.chains.filter((c) => c.residueCount > 0).map((c) => `${c.id} N端/C端`))
        : highlight.map((h) => h.label),
      warnings,
    },
  }
}

const structureTool = (state, config) => localTool({
  name: 'sci_viz_structure',
  description:
    '在 DSH 图形界面的「科研可视化」窗口里打开一个蛋白质/核酸三维结构（本地 PDB/mmCIF 文件、4 位 PDB ID，或 http(s) 链接），' +
    '可切换卡通/骨架/球棍/空间填充/仅配体表现方式，并可高亮指定残基（例如抗结核药靶点突变 S315T、D94G、S450L）。' +
    '当你要向用户描述一个三维结构、突变位点位置、配体结合口袋、链的排布时，用它代替大段文字描述。' +
    '返回链数、残基数、配体与二级结构来源等要点，便于你据此继续解说。',
  parameters: STRUCTURE_PARAMS,
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'title', 'summary', 'chains', 'residues', 'atoms', 'ligands', 'highlighted', 'warnings'],
      properties: {
        ok: { type: 'boolean' },
        title: { type: 'string' },
        summary: { type: 'string' },
        chains: { type: 'integer' },
        residues: { type: 'integer' },
        atoms: { type: 'integer' },
        ligands: { type: 'array', items: { type: 'string' } },
        highlighted: { type: 'array', items: { type: 'string' } },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.summary }],
  },
  async execute(args) {
    const { doc, value } = await buildStructureDoc(args, config)
    await state.put(doc)
    return value
  },
})

/** `sci_viz_stats` 的参数表（面板的「运行」与工具共用同一份）。 */
const STATS_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: { type: 'string', enum: STAT_KINDS, description: '分析类型' },
    survivalGroups: {
      type: 'array',
      description: 'survival：生存数据，如 [{"label":"对照","times":[3,8,12],"events":[1,0,1]}]；'
        + 'events 1=事件发生、0=删失（随访中）。删失必须给，否则生存率会被算低',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['times', 'events'],
        properties: {
          label: { type: 'string' },
          times: { type: 'array', items: { type: 'number' }, description: '随访时间' },
          events: { type: 'array', items: { type: 'number' }, description: '1=事件发生，0=删失' },
        },
      },
    },
    rocCurves: {
      type: 'array',
      description: 'roc：一条或多条曲线，如 [{"label":"模型A","labels":[1,0,1],"scores":[0.9,0.2,0.7]}]；'
        + 'scores 越大越倾向阳性',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['labels', 'scores'],
        properties: {
          label: { type: 'string' },
          labels: { type: 'array', items: { type: 'number' }, description: '1=阳性，0=阴性' },
          scores: { type: 'array', items: { type: 'number' }, description: '连续打分，越大越倾向阳性' },
        },
      },
    },
    showCensor: { type: 'boolean', description: 'survival：是否在曲线上标出删失位置（默认标）' },
    groups: {
      type: 'array',
      description: '分组数据，如 [{"label":"对照组","values":[1,2,3]}, ...]',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'values'],
        properties: {
          label: { type: 'string' },
          values: { type: 'array', items: { type: 'number' } },
        },
      },
    },
    values: { type: 'array', items: { type: 'number' }, description: '单组数据（单样本 t 检验 / 描述统计 / 正态拟合）' },
    x: { type: 'array', items: { type: 'number' }, description: '回归的自变量' },
    y: { type: 'array', items: { type: 'number' }, description: '回归的因变量' },
    table: {
      type: 'array',
      description: '卡方检验的二维计数表，如 [[18,7],[6,19]]',
      items: { type: 'array', items: { type: 'number' } },
    },
    rowLabels: { type: 'array', items: { type: 'string' } },
    colLabels: { type: 'array', items: { type: 'string' } },
    mu: { type: 'number', description: '单样本 t 检验的零假设均值 / 正态分布均值' },
    sigma: { type: 'number', description: '正态分布标准差（不给则用样本 SD）' },
    paired: { type: 'boolean', description: 't 检验是否配对' },
    welch: { type: 'boolean', description: '独立 t 检验是否用 Welch（默认 true）' },
    alternative: { type: 'string', enum: ['two-sided', 'greater', 'less'], description: '备择假设方向' },
    d: { type: 'number', description: "功效分析：效应量 Cohen's d" },
    power: { type: 'number', description: '功效分析：目标功效，默认 0.8' },
    alpha: { type: 'number', description: '显著性水平，默认 0.05' },
    bins: { type: 'integer', description: '直方图分箱数（不给则按 Freedman-Diaconis 规则）' },
    title: { type: 'string', description: '窗口标题' },
    xLabel: { type: 'string' },
    yLabel: { type: 'string' },
    note: { type: 'string', description: '显示在窗口里的一句注解（例如数据来源、实验条件）' },
  },
}

/**
 * 力导向布局（Fruchterman-Reingold 简化版）。
 *
 * 放在宿主的理由和聚类一样：渲染器不算布局，且确定性布局能在 Node 里断言。
 * **无随机数** —— 初值按圆周均匀铺开，同样输入必然得到同样的图（随机初值会让
 * 每次调用图都不一样，用户会以为出了 bug）。
 *
 * 加了向中心的弱引力：不然孤立子图会被斥力推到无穷远。
 * 复杂度 O(n² × 迭代)；n 上限 300，超过就只按圆周铺（不迭代），并回报这一点。
 */
function networkLayout(nodes, edges, opts = {}) {
  const W = Number(opts.width) || 1000
  const H = Number(opts.height) || 700
  const n = nodes.length
  const idx = new Map(nodes.map((nd, i) => [String(nd.id ?? nd.label ?? i), i]))
  const pos = nodes.map((nd, i) => ({
    x: W / 2 + Math.cos((i / Math.max(1, n)) * Math.PI * 2 + 0.4) * Math.min(W, H) * 0.34,
    y: H / 2 + Math.sin((i / Math.max(1, n)) * Math.PI * 2 + 0.4) * Math.min(W, H) * 0.34,
  }))
  const links = []
  for (const e of edges || []) {
    const a = idx.get(String(e.source ?? e.from))
    const b = idx.get(String(e.target ?? e.to))
    if (a === undefined || b === undefined || a === b) continue
    links.push([a, b, Number(e.weight) || 1])
  }
  const dense = n > 300
  if (dense || n === 0) return { positions: pos, links, dense }

  const k = Math.sqrt((W * H) / Math.max(1, n)) * 0.62
  const iterations = Number(opts.iterations) || 320
  let temp = W / 9
  for (let it = 0; it < iterations; it += 1) {
    const dx = new Float64Array(n)
    const dy = new Float64Array(n)
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        let ax = pos[i].x - pos[j].x
        let ay = pos[i].y - pos[j].y
        let d2 = ax * ax + ay * ay
        if (d2 < 0.01) { ax = 0.1; ay = 0.1; d2 = 0.02 }
        const d = Math.sqrt(d2)
        const f = (k * k) / d
        dx[i] += (ax / d) * f
        dy[i] += (ay / d) * f
        dx[j] -= (ax / d) * f
        dy[j] -= (ay / d) * f
      }
    }
    for (const [a, b, w] of links) {
      const ax = pos[a].x - pos[b].x
      const ay = pos[a].y - pos[b].y
      const d = Math.max(0.01, Math.hypot(ax, ay))
      const f = ((d * d) / k) * Math.min(2.5, w)
      dx[a] -= (ax / d) * f
      dy[a] -= (ay / d) * f
      dx[b] += (ax / d) * f
      dy[b] += (ay / d) * f
    }
    for (let i = 0; i < n; i += 1) {
      dx[i] += (W / 2 - pos[i].x) * 0.02
      dy[i] += (H / 2 - pos[i].y) * 0.02
      const d = Math.hypot(dx[i], dy[i]) || 0.001
      const lim = Math.min(d, temp)
      pos[i].x = Math.max(16, Math.min(W - 16, pos[i].x + (dx[i] / d) * lim))
      pos[i].y = Math.max(16, Math.min(H - 16, pos[i].y + (dy[i] / d) * lim))
    }
    temp *= 0.975
  }
  return { positions: pos, links, dense: false }
}

/**
 * 序列 Logo 的列统计：每列各字母频率 + 信息量（bits）。
 *
 * bits = log2(字母表大小) − 香农熵，这是 Logo 的标准定义（序列保守则该列接近满值）。
 * 字母表按数据自动判断：只有 ACGTU 就当核酸（上限 2 bits），否则当蛋白（上限 log2(20)）。
 * 间隙（- 和 .）不参与统计 —— 把 gap 算进去会把保守列的信息量压低，是常见的错法。
 */
function logoColumns(sequences) {
  const seqs = (sequences || []).map((s) => String(s.seq ?? s.sequence ?? '').toUpperCase())
  const good = seqs.filter((s) => s.length > 0)
  if (good.length === 0) return null
  const maxLen = Math.max(...good.map((s) => s.length))
  let isNt = true
  for (const s of good) {
    for (const ch of s) if (ch !== '-' && ch !== '.' && !'ACGTU'.includes(ch)) { isNt = false; break }
    if (!isNt) break
  }
  const alphabet = isNt ? 4 : 20
  const maxBits = Math.log2(alphabet)
  const columns = []
  for (let c = 0; c < maxLen; c += 1) {
    const counts = new Map()
    let used = 0
    for (const s of good) {
      const ch = s[c]
      if (ch === undefined || ch === '-' || ch === '.') continue
      counts.set(ch, (counts.get(ch) || 0) + 1)
      used += 1
    }
    if (used === 0) { columns.push({ bits: 0, letters: [] }); continue }
    let h = 0
    const letters = []
    for (const [ch, cnt] of counts) {
      const p = cnt / used
      h -= p * Math.log2(p)
      letters.push([ch, p])
    }
    letters.sort((a, b) => b[1] - a[1])
    columns.push({ bits: Math.max(0, maxBits - h), letters })
  }
  return { columns, maxBits, isNt, n: good.length, length: maxLen }
}

/**
 * 这个插件 HTTP 服务的真实来源地址（给「独立窗口」用）。
 *
 * 桌面版渲染进程在 dsh-app:// 协议下，location.origin 是 `dsh-app://app`，
 * 拼出来的地址在浏览器里打不开。真地址有两个来源，按可靠性排序：
 *   1. DSH_WEB_URL 环境变量（实测是 http://127.0.0.1:19387）
 *   2. 请求的 Host 头（浏览器/代理直连时是对的；走自定义协议时可能是假的）
 * 都拿不到就返回空串，调用方自己决定怎么提示。
 */
function viewerOrigin(req) {
  const fromEnv = process.env.DSH_WEB_URL
  if (fromEnv && /^https?:\/\//i.test(fromEnv)) return fromEnv.replace(/\/+$/, '')
  const host = req?.headers?.host
  if (host && /^[a-z0-9.\-]+(:\d+)?$/i.test(host)) return `http://${host}`
  return ''
}

/**
 * 独立窗口页面的 HTML。
 *
 * 这个函数返回的是模板字符串，所以**页面自己的 JS 里不能出现反引号或 ${** ——
 * 会把外层模板串截断（反引号这个坑在 CSS 注释和 manifest 正文上各踩过一次）。
 * 页面内的字符串一律用单引号与加号拼接。
 *
 * 页面不重写渲染器：它把 /api/sci-viz/client.js（就是本插件的浏览器半边）当模块加载，
 * 用其中的 __internals 画图 —— 渲染逻辑永远只有一份，两边的图不可能长得不一样。
 */
function renderViewerPage(api) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>科研可视化 · 独立窗口</title>
<style>
  :root { color-scheme: dark }
  * { box-sizing: border-box }
  html, body { margin:0; height:100%; background:#0d1117; color:#e6edf3;
    font:13px/1.5 ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif }
  body { display:flex; flex-direction:column }
  header { flex:none; display:flex; align-items:center; gap:10px; padding:8px 12px;
    border-bottom:1px solid rgba(255,255,255,.1); background:rgba(255,255,255,.03) }
  #title { font-weight:600; font-size:14px; flex:none }
  #sub { color:#8fa3b8; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1 }
  #status { color:#8fa3b8; font-size:12px; flex:none }
  button { border:1px solid rgba(255,255,255,.18); background:rgba(255,255,255,.06);
    color:#dbe4ee; border-radius:6px; padding:4px 10px; cursor:pointer; font:inherit; flex:none }
  button:hover { border-color:rgba(76,154,255,.5); color:#fff }
  button.on { background:rgba(76,154,255,.24); border-color:rgba(76,154,255,.5); color:#dceaff }
  main { flex:1; min-height:0; position:relative; overflow:auto }
  canvas { display:block; width:100% }
  #empty { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
    color:#5b6b7c; text-align:center; padding:20px; pointer-events:none }
  #empty[hidden] { display:none }
</style>
</head>
<body>
<header>
  <span id="title">科研可视化</span>
  <span id="sub">等待数据…</span>
  <button id="btn-follow" class="on" title="宿主推新内容时自动切过去">跟随更新</button>
  <button id="btn-png" title="导出当前画面为 PNG">PNG</button>
  <button id="btn-svg" title="导出为 SVG 矢量图（投稿用）">SVG</button>
  <span id="status"></span>
</header>
<main>
  <canvas id="cv"></canvas>
  <div id="empty">还没有可显示的内容。<br>让模型推一张图过来；三维结构可以按住拖动旋转。</div>
</main>
<script>
  /* 给 bundle 一个最小加载器：这个页面只要它的 __internals，不需要 DSH 的槽位。 */
  window.__ModuleLoader__ = {
    load: function (spec) {
      try { window.__sciViz = spec.factory(function () { throw new Error('viewer 里没有 require'); }); }
      catch (e) { window.__sciVizError = String(e && e.message ? e.message : e); }
    },
  };
</script>
<script src="${api}/client.js"></script>
<script>
(function () {
  var API = '${api}';
  var I = window.__sciViz && window.__sciViz.__internals;
  var cv = document.getElementById('cv');
  var g = cv.getContext('2d');
  var elTitle = document.getElementById('title');
  var elSub = document.getElementById('sub');
  var elStatus = document.getElementById('status');
  var elEmpty = document.getElementById('empty');
  var btnFollow = document.getElementById('btn-follow');

  if (!I) {
    elStatus.textContent = '渲染器加载失败';
    elEmpty.textContent = '渲染器没能加载：' + (window.__sciVizError || '未知原因');
    return;
  }

  var doc = null, view = null, rev = -1, follow = true, timer = 0;

  function setStatus(t) { elStatus.textContent = t || ''; }

  function size() {
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(240, cv.parentElement.clientWidth);
    var needH = (doc && doc.kind === 'chart') ? I.chartMinHeight(doc, w) : 0;
    var h = Math.max(cv.parentElement.clientHeight, needH, 240);
    cv.style.height = h + 'px';
    cv.width = Math.floor(w * dpr);
    cv.height = Math.floor(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: w, h: h };
  }

  function paint() {
    var s = size();
    g.clearRect(0, 0, s.w, s.h);
    if (!doc) return;
    if (doc.kind === 'structure' && view) I.paintStructure(g, view, s.w, s.h);
    else if (doc.kind === 'chart') I.paintChart(g, doc, s.w, s.h);
  }
  function schedule() {
    if (timer) return;
    timer = requestAnimationFrame(function () { timer = 0; paint(); });
  }

  function adopt(next) {
    doc = next;
    view = null;
    if (doc && doc.kind === 'structure') {
      view = I.createStructureView(doc);
      var saved = null;
      try { saved = JSON.parse(localStorage.getItem('sciviz.termini')); } catch (e) {}
      if (view && typeof view.setTermini === 'function' && typeof saved === 'boolean') view.setTermini(saved);
      if (view) view._fitScale = undefined;
    }
    elTitle.textContent = (doc && doc.title) || '科研可视化';
    elSub.textContent = (doc && (doc.subtitle || doc.note)) || '';
    document.title = (doc && doc.title) ? doc.title + ' · 可视化' : '科研可视化 · 独立窗口';
    elEmpty.hidden = !!doc;
    schedule();
  }

  function poll() {
    fetch(API + '/state', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        setStatus('已连接');
        if (!j || !j.doc) { if (doc) adopt(null); return; }
        if (!follow || j.rev === rev) return;
        rev = j.rev;
        adopt(j.doc);
      })
      .catch(function () { setStatus('连不上宿主（DSH 没在运行？）'); });
  }

  btnFollow.addEventListener('click', function () {
    follow = !follow;
    btnFollow.classList.toggle('on', follow);
    if (follow) poll();
  });

  function download(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }
  function safeName(t, ext) {
    var base = String(t || 'figure').replace(/[\\\\/:*?"<>|]/g, '_').slice(0, 60);
    return base + '.' + ext;
  }
  function withView(cb, w, h) {
    var keep = view ? view._fitScale : undefined;
    if (view) view._fitScale = undefined;
    try { cb(); } finally { if (view) view._fitScale = keep; }
  }

  document.getElementById('btn-png').addEventListener('click', function () {
    if (!doc) return;
    var dpr = window.devicePixelRatio || 1;
    var w = Math.floor(cv.width / dpr * 2), h = Math.floor(cv.height / dpr * 2);
    var off = document.createElement('canvas');
    off.width = w; off.height = h;
    var og = off.getContext('2d');
    withView(function () {
      if (doc.kind === 'structure' && view) I.paintStructure(og, view, w, h);
      else if (doc.kind === 'chart') I.paintChart(og, doc, w, h);
    });
    off.toBlob(function (b) { if (b) download(b, safeName(doc.title, 'png')); setStatus('已导出 PNG'); }, 'image/png');
  });

  document.getElementById('btn-svg').addEventListener('click', function () {
    if (!doc) return;
    var dpr = window.devicePixelRatio || 1;
    var w = Math.floor(cv.width / dpr), h = Math.floor(cv.height / dpr);
    var rec = I.createSvgRecorder(w, h);
    withView(function () {
      if (doc.kind === 'structure' && view) I.paintStructure(rec, view, w, h);
      else if (doc.kind === 'chart') I.paintChart(rec, doc, w, h);
    });
    download(new Blob([rec.toSvg()], { type: 'image/svg+xml;charset=utf-8' }), safeName(doc.title, 'svg'));
    setStatus('已导出 SVG');
  });

  var drag = null;
  cv.addEventListener('pointerdown', function (e) {
    if (!view) return;
    try { cv.setPointerCapture(e.pointerId); } catch (err) {}
    drag = { x: e.clientX, y: e.clientY, yaw: view.view.yaw, pitch: view.view.pitch };
  });
  cv.addEventListener('pointermove', function (e) {
    if (!drag || !view) return;
    view.view.yaw = drag.yaw + (e.clientX - drag.x) * 0.009;
    var p = drag.pitch + (e.clientY - drag.y) * 0.009;
    view.view.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, p));
    schedule();
  });
  cv.addEventListener('pointerup', function (e) {
    drag = null;
    try { cv.releasePointerCapture(e.pointerId); } catch (err) {}
  });
  cv.addEventListener('wheel', function (e) {
    if (!view) return;
    e.preventDefault();
    view.view.zoom = Math.max(0.12, Math.min(24, view.view.zoom * Math.exp(-e.deltaY * 0.0012)));
    schedule();
  }, { passive: false });
  cv.addEventListener('dblclick', function () {
    if (!view) return;
    if (typeof view.resetView === 'function') view.resetView();
    else { view.view.yaw = 0; view.view.pitch = 0; view.view.zoom = 1; }
    view._fitScale = undefined;
    schedule();
  });
  window.addEventListener('resize', function () {
    if (view) view._fitScale = undefined;
    schedule();
  });

  poll();
  setInterval(poll, 1200);
})();
</script>
</body>
</html>
`
}

/** 基因组学任务的公共实现：拼面板 + 拼文档。工具与 HTTP 路由都调它。 */
function buildGenomicsDoc(args) {
  const built = buildGenomicsPanel(args)
  return {
    doc: {
      kind: 'chart',
      title: args.title || built.panel.title,
      subtitle: args.note ?? '',
      panels: [built.panel],
      table: built.table ?? null,
      note: args.note ?? '',
      pushedAt: Date.now(),
      autoOpen: true,
      /** 浏览器半边据此把这张图切到「基因组」标签页，而不是塞进统计图表里 */
      section: 'genome',
    },
    value: { summary: built.summary },
  }
}

/**
 * 把面板上粘贴的文本解析成 buildGenomicsPanel 的参数。
 *
 * 放在宿主而不是浏览器：解析逻辑能在 Node 里直接断言，不用去驱动浏览器。
 * 各格式都尽量宽松 —— 用户在面板上粘贴的是从别处复制来的东西，
 * 末尾多个制表符、表头、注释行都不该让它失败。
 */
function parseGenomicsText(kind, text) {
  const raw = String(text || '').replace(/\r\n?/g, '\n')
  // 只去行尾空白：行首那个制表符是热图表头的「角格」，trim 掉会丢掉第一个列名
  const lines = raw.split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))
  if (lines.length === 0) throw new Error('没有内容：把数据粘贴进输入框再点运行')

  /** 按制表符 / 逗号 / 连续空格切列（制表符优先，因为标签里常有空格）。 */
  const cols = (l) => (l.includes('\t') ? l.split('\t') : l.includes(',') ? l.split(',') : l.split(/\s{2,}|\s+/))
    .map((s) => s.trim())

  const num = (s) => {
    const t = String(s).trim()
    // 空串必须当「没有值」：Number('') === 0，会让热图表的角格被误认成数字 0
    if (t === '') return null
    const v = Number(t.replace(/[%¥$,]/g, ''))
    return isFinite(v) ? v : null
  }
  const looksHeader = (c) => c.some((x) => /^(term|pathway|category|gene|chrom|chromosome|pos|position|type|sample|label|id|count|p|pvalue|padj|fdr|ratio|lfc|log2fc|depth|coverage|name|start|end|time|event)$/i.test(x))

  if (kind === 'phylo') {
    // Newick 可能跨多行，拼回一行再交给解析器
    const newick = lines.join('')
    if (!/[(),;]/.test(newick)) throw new Error('这不像 Newick：至少要有一个括号或逗号，且以分号结尾')
    return { newick }
  }

  if (kind === 'msa' || kind === 'logo') {
    const seqs = []
    let name = null
    let buf = []
    const push = () => { if (name !== null) seqs.push({ name, seq: buf.join('') }) }
    for (const l of lines) {
      if (l.startsWith('>')) {
        push()
        name = l.slice(1).trim() || `序列${seqs.length + 1}`
        buf = []
      } else if (name !== null) {
        buf.push(l.replace(/[\s\d]/g, ''))
      } else {
        // 没有 > 头：每行当一条无名序列
        name = `序列${seqs.length + 1}`
        buf = [l.replace(/[\s\d]/g, '')]
      }
    }
    push()
    const good = seqs.filter((s) => s.seq.length > 0)
    if (good.length < 2) throw new Error(`FASTA 至少要两条序列，现在解析出 ${good.length} 条`)
    const maxLen = Math.max(...good.map((s) => s.seq.length))
    const minLen = Math.min(...good.map((s) => s.seq.length))
    if (maxLen !== minLen) {
      // 长度不等就不像「已比对」的序列，明确提示而不是画出一张错位的图
      throw new Error(`序列长度不一致（${minLen}–${maxLen}）：比对图要求先把序列比对好，长度必须相同`)
    }
    // Logo 与比对吃同一份 FASTA，只是后面画法不同
    return kind === 'logo' ? { logoSequences: good } : { sequences: good }
  }

  if (kind === 'network') {
    // 边表：每行「源 靶 [权重]」，节点从边里推出来、大小按度数
    const edges = []
    for (const l of lines) {
      const c = cols(l)
      if (c.length < 2) continue
      const a = c[0]
      const b = c[1]
      if (!a || !b || a === b) continue
      if (num(a) !== null && num(b) !== null && c.length < 3) continue // 纯数字两列不是边
      edges.push({ source: a, target: b, weight: c[2] !== undefined ? (num(c[2]) ?? 1) : 1 })
    }
    if (edges.length === 0) throw new Error('每行应是「源 靶 [权重]」，例如 katG inhA 0.95')
    const ids = [...new Set(edges.flatMap((e) => [e.source, e.target]))]
    return { nodes: ids.map((id) => ({ id, label: id })), edges }
  }

  if (kind === 'enrich' || kind === 'volcano' || kind === 'coverage' || kind === 'heatmap' || kind === 'genome') {
    const body = looksHeader(cols(lines[0])) ? lines.slice(1) : lines
    if (body.length === 0) throw new Error('只有表头，没有数据行')

    if (kind === 'heatmap') {
      const grid = []
      const rowLabels = []
      let colLabels = []
      let start = 0
      // 第一行若「第一列非数字、其余也非数字」，那是列名表头
      const first = cols(lines[0])
      if (first.length > 1 && num(first[0]) === null && first.slice(1).every((x) => num(x) === null)) {
        colLabels = first.slice(1)
        start = 1
      }
      for (let i = start; i < lines.length; i += 1) {
        const c = cols(lines[i])
        const head = num(c[0])
        const off = head === null ? 1 : 0
        if (head === null) rowLabels.push(c[0])
        const row = c.slice(off).map(num)
        if (row.length && row.some((v) => v !== null)) grid.push(row)
      }
      if (grid.length === 0) throw new Error('没有解析出数字矩阵：每行应是「行名 数值 数值 …」或纯数值')
      return { values: grid, rowLabels, colLabels }
    }

    if (kind === 'enrich') {
      const terms = []
      for (const l of body) {
        const c = cols(l)
        const pIdx = c.findIndex((x, i) => i > 0 && num(x) !== null && num(x) >= 0 && num(x) <= 1)
        const nums = c.map((x, i) => ({ v: num(x), i })).filter((o) => o.v !== null)
        if (nums.length < 2) { terms.push({ term: c[0], count: 1, p: 0.05 }); continue }
        const p = pIdx > 0 ? num(c[pIdx]) : nums[nums.length - 1].v
        const count = nums.find((o) => Number.isInteger(o.v) && o.i !== pIdx)?.v ?? 1
        terms.push({
          term: c[0],
          count: Math.max(1, Math.round(count)),
          p: p > 0 ? p : 1e-300,
          category: c.length > 3 && num(c[c.length - 1]) === null ? c[c.length - 1] : undefined,
        })
      }
      return { terms }
    }

    if (kind === 'volcano') {
      const points = []
      const labels = []
      for (const l of body) {
        const c = cols(l)
        // 第一列非数字就是基因名（有名字才标，否则标不上去）
        const hasLabel = num(c[0]) === null
        const x = num(c[hasLabel ? 1 : 0])
        const y = num(c[hasLabel ? 2 : 1])
        if (x === null || y === null) continue
        points.push([x, y])
        if (hasLabel && c[0]) labels.push({ name: c[0], x, y })
      }
      if (points.length === 0) throw new Error('每行至少要有两列数字：log2FC 和 -log10(p)')
      return { points, labels }
    }

    if (kind === 'coverage') {
      const tracks = []
      let cur = null
      for (const l of body) {
        const c = cols(l)
        const nums = c.map(num).filter((v) => v !== null)
        if (nums.length >= 2) {
          if (!cur) { cur = { name: `样本${tracks.length + 1}`, points: [] } }
          cur.points.push([nums[0], nums[1]])
        } else if (c.length === 1 && num(c[0]) === null) {
          if (cur) tracks.push(cur)
          cur = { name: c[0], points: [] }
        }
      }
      if (cur) tracks.push(cur)
      const good = tracks.filter((t) => t.points.length > 0)
      if (good.length === 0) throw new Error('每行应是「位置 深度」，或用一行样本名分组')
      return { tracks: good }
    }

    // genome：每行「染色体 位置 [类型] [标签]」
    const chromLen = new Map()
    const variants = []
    for (const l of body) {
      const c = cols(l)
      const chrom = c[0]
      const pos = num(c[1])
      if (pos === null) continue
      const rest = c.slice(2)
      const type = rest.find((x) => /^(snp|indel|cnv|sv|deletion|insertion|mnv)$/i.test(x)) || 'SNP'
      const label = rest.find((x) => num(x) === null && !/^(snp|indel|cnv|sv)$/i.test(x))
      variants.push({ chrom, pos, type, label })
      if (!chromLen.has(chrom) || pos > chromLen.get(chrom)) chromLen.set(chrom, pos)
    }
    if (variants.length === 0) throw new Error('每行应是「染色体 位置 [类型] [标签]」，位置必须是数字')
    // 没给长度就按该染色体最大位置取整（画图只需要相对位置）
    const chromosomes = [...chromLen.entries()].map(([name, maxPos]) => ({
      name, length: Math.max(1, Math.ceil(maxPos * 1.02)),
    }))
    return { chromosomes, variants }
  }
  throw new Error(`这个 kind 还不支持粘贴文本：${kind}`)
}

/** 统计任务的公共实现：算 + 拼文档。工具与 HTTP 路由都调它。 */
function buildStatsDoc(args) {
  const built = buildChart(args.kind, args)
  const doc = {
    kind: 'chart',
    title: args.title ?? chartTitle(args.kind),
    subtitle: args.note ?? '',
    panels: built.panels,
    table: built.table,
    note: args.note ?? '',
    pushedAt: Date.now(),
    /** 工具推来的图表：让浏览器半边主动把面板翻出来（见 buildStructureDoc 里的说明） */
    autoOpen: true,
  }
  const summary = statsSummary(args.kind, built)
  return {
    doc,
    built,
    value: {
      ok: true,
      title: doc.title,
      summary: `${summary}。已在可视化窗口绘制 ${built.panels.length} 个面板：${built.panels.map((p) => p.title).join('、')}`,
      panels: built.panels.length,
      result: JSON.stringify(built.result ?? {}, (_k, v) => (typeof v === 'number' ? Number(v.toFixed(6)) : v)).slice(0, 4000),
    },
  }
}

const statsTool = (state) => localTool({
  name: 'sci_viz_stats',
  description:
    '做统计分析**并**在图形界面的「科研可视化」窗口里画出对应的图（不是只给数字）。' +
    'kind 可选：normal（正态分布曲线 + 累积分布，可附直方图与 Q-Q 图）、ttest（单样本/独立/Welch/配对 t 检验，' +
    '画 t 分布拒绝域 + 分组箱线图 + 效应量森林图）、anova（单因素方差分析 + F 分布 + 事后两两比较）、' +
    'chisq（卡方独立性检验）、regression（散点 + 回归线 + 95% 置信带 + 残差图）、power（功效曲线与样本量）、' +
    'descriptives（描述统计 + 箱线图 + 直方图）。p 值为精确计算（不完全 Beta/Gamma，已与 scipy 对拍）。',
  parameters: STATS_PARAMS,
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'title', 'summary', 'panels', 'result'],
      properties: {
        ok: { type: 'boolean' },
        title: { type: 'string' },
        summary: { type: 'string' },
        panels: { type: 'integer' },
        result: { type: 'string' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.summary }],
  },
  async execute(args) {
    const { doc, value } = buildStatsDoc(args)
    await state.put(doc)
    return value
  },
})

const plotTool = (state) => localTool({
  name: 'sci_viz_plot',
  description:
    '通用绘图入口：当 sci_viz_stats 的几种统计图都不合适（例如画动力学曲线、剂量-反应曲线、自定义散点、' +
    '示意图）时，直接给出一组面板定义，宿主原样送到可视化窗口。每个面板是 {kind, title, xLabel, yLabel, layers}，' +
    'layer 支持 area / line / points / bars / boxes / hist / errorbars / vline / hline / rect / text。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'panels'],
    properties: {
      title: { type: 'string', description: '窗口标题' },
      panels: {
        type: 'array',
        description: '面板数组；每个面板 {kind:"xy"|"bars"|"boxes"|"scatter"|"hist"|"forest"|"qq", title, xLabel, yLabel, xDomain?, yDomain?, xTickLabels?, layers:[...], caption?}',
        items: { type: 'object', additionalProperties: true },
      },
      table: {
        type: 'object',
        additionalProperties: false,
        description: '可选的数据表 {title, columns:[], rows:[[]]}',
        properties: {
          title: { type: 'string' },
          columns: { type: 'array', items: { type: 'string' } },
          rows: { type: 'array', items: { type: 'array', items: {} } },
        },
      },
      note: { type: 'string' },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'title', 'summary', 'panels'],
      properties: {
        ok: { type: 'boolean' },
        title: { type: 'string' },
        summary: { type: 'string' },
        panels: { type: 'integer' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.summary }],
  },
  async execute(args) {
    const panels = (args.panels ?? []).slice(0, 6)
    if (panels.length === 0) throw new Error('panels 不能为空')
    for (const p of panels) {
      if (!Array.isArray(p.layers)) throw new Error(`面板「${p.title ?? '?'}」缺少 layers 数组`)
    }
    const doc = {
      kind: 'chart',
      title: args.title,
      subtitle: args.note ?? '',
      panels,
      table: args.table ?? null,
      note: args.note ?? '',
      pushedAt: Date.now(),
    }
    const rev = await state.put(doc)
    return {
      ok: true,
      title: doc.title,
      summary: `已在可视化窗口绘制「${doc.title}」，共 ${panels.length} 个面板：${panels.map((p) => p.title ?? '未命名').join('、')}`,
      panels: panels.length,
    }
  },
})

// ---------------------------------------------------------------------------
// 基因组学可视化：进化树 / 序列比对 / GO·KEGG 富集 / 全基因组变异 / 覆盖度 / 火山图
//
// 这几类图对应技能库里的 phylogenetics·etetoolkit、protein_sequence_msa、
// pathway-enrichment·reactome_database、pysam·deeptools·tiledbvcf、pydeseq2。
// 渲染在浏览器半边（lib/client.js 的 drawPhylo/drawMsa/... ），宿主这里只负责把
// 调用方给的数据整理成面板定义，并生成一段能读懂的小结。
// ---------------------------------------------------------------------------

const GENOMICS_KINDS = ['phylo', 'msa', 'enrich', 'genome', 'coverage', 'volcano', 'heatmap',
  'network', 'logo']

const GENOMICS_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: {
      type: 'string',
      enum: GENOMICS_KINDS,
      description: 'phylo=进化树(Newick) · msa=多序列比对 · enrich=GO/KEGG富集气泡图 · '
        + 'genome=全基因组变异分布 · coverage=测序覆盖度轨道 · volcano=差异表达火山图',
    },
    title: { type: 'string', description: '窗口标题' },
    note: { type: 'string', description: '显示在窗口里的一句注解（数据来源、样本、参数）' },
    // —— phylo ——
    newick: { type: 'string', description: 'phylo：Newick 字符串，支持分支长度与 bootstrap 值，如 "(A:0.1,B:0.2)95:0.3;"' },
    groups: {
      type: 'array',
      description: 'phylo：按叶子名分组着色，如 [{"name":"耐药株","color":"#e56b6f","labels":["S1","S2"]}]；labels 里以 * 结尾表示前缀匹配',
      items: { type: 'object', additionalProperties: true },
    },
    showSupport: { type: 'boolean', description: 'phylo：是否标注内部节点的支持率/Bootstrap（叶子超过 30 个时自动不标）' },
    // —— msa ——
    sequences: {
      type: 'array',
      description: 'msa：已比对好的序列，如 [{"name":"H37Rv","seq":"MKTV..."}]，长度须一致（允许末尾长度不同，短的按缺失处理）',
      items: { type: 'object', additionalProperties: true },
    },
    colorBy: {
      type: 'string',
      enum: ['residue', 'conservation'],
      description: 'msa：残基按化学性质着色（默认），或按该列保守度着色',
    },
    // —— enrich ——
    terms: {
      type: 'array',
      description: 'enrich：富集条目，如 [{"term":"ABC transporters","count":12,"p":1.2e-6,"ratio":0.18,"category":"KEGG"}]',
      items: { type: 'object', additionalProperties: true },
    },
    top: { type: 'integer', description: 'enrich：最多画多少条（按 p 值排序，默认 20）' },
    // —— genome ——
    chromosomes: {
      type: 'array',
      description: 'genome：染色体及其长度，如 [{"name":"chr1","length":4500000}]',
      items: { type: 'object', additionalProperties: true },
    },
    variants: {
      type: 'array',
      description: 'genome：变异位点，如 [{"chrom":"chr1","pos":123456,"type":"SNP","label":"katG S315T"}]',
      items: { type: 'object', additionalProperties: true },
    },
    // —— coverage ——
    tracks: {
      type: 'array',
      description: 'coverage：覆盖度轨道，如 [{"name":"Sample1","points":[[0,3],[100,17],...]}]',
      items: { type: 'object', additionalProperties: true },
    },
    genes: {
      type: 'array',
      description: 'coverage：可选基因模型，如 [{"name":"gyrA","start":5000,"end":7500}]，画在轨道下方',
      items: { type: 'object', additionalProperties: true },
    },
    // —— volcano ——
    points: {
      type: 'array',
      description: 'volcano：点集 [[log2FC, -log10(p)], ...]',
      items: { type: 'array', items: { type: 'number' } },
    },
    labels: {
      type: 'array',
      description: 'volcano：要标注的基因，如 [{"name":"Rv0001","x":-3.2,"y":8.1}]',
      items: { type: 'object', additionalProperties: true },
    },
    lfcCutoff: { type: 'number', description: 'volcano：|log2FC| 阈值，默认 1' },
    pCutoff: { type: 'number', description: 'volcano：p 阈值，默认 0.05' },
    // —— heatmap ——
    values: {
      type: 'array',
      description: 'heatmap：二维数字矩阵，如 [[1.2,-0.4],[0.8,1.9]]（行 × 列）；缺值用 null',
      items: { type: 'array', items: { type: 'number' } },
    },
    rowLabels: { type: 'array', items: { type: 'string' }, description: 'heatmap：行名（基因名），与矩阵行同序' },
    colLabels: { type: 'array', items: { type: 'string' }, description: 'heatmap：列名（样本名），与矩阵列同序' },
    palette: {
      type: 'string',
      enum: ['redblue', 'redyellowgreen', 'viridis', 'grays'],
      description: 'heatmap：色阶，默认 redblue（蓝-白-红，发散）',
    },
    scale: {
      type: 'string',
      enum: ['centered', 'minmax'],
      description: 'heatmap：centered（默认）把 0 放在正中，适合 z-score / log2FC；minmax 按最小最大铺满，适合相关性矩阵',
    },
    showValues: { type: 'boolean', description: 'heatmap：格子里写出数值（仅当格子够大时生效）' },
    cluster: { type: 'boolean', description: 'heatmap：行与列都做层次聚类（平均连接 + 欧氏距离）' },
    clusterRows: { type: 'boolean', description: 'heatmap：只对行聚类' },
    clusterCols: { type: 'boolean', description: 'heatmap：只对列聚类' },
    // —— network ——
    nodes: {
      type: 'array',
      description: 'network：节点，如 [{"id":"katG","label":"katG","group":"耐药基因","size":12}]；size 默认按度数',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          group: { type: 'string', description: '分组，决定颜色；会画成图例' },
          size: { type: 'number', description: '节点大小（如互作得分 / 连接数）' },
          color: { type: 'string' },
        },
      },
    },
    edges: {
      type: 'array',
      description: 'network：边，如 [{"source":"katG","target":"inhA","weight":0.8}]',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source', 'target'],
        properties: {
          source: { type: 'string' },
          target: { type: 'string' },
          weight: { type: 'number', description: '权重，决定线的粗细' },
          color: { type: 'string' },
        },
      },
    },
    // —— logo ——
    logoSequences: {
      type: 'array',
      description: 'logo：已比对的序列（长度须一致），如 [{"name":"H37Rv","seq":"MKTV"}]；'
        + '自动判断核酸/蛋白，间隙不参与统计',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['seq'],
        properties: { name: { type: 'string' }, seq: { type: 'string' } },
      },
    },
    xLabel: { type: 'string' },
    yLabel: { type: 'string' },
  },
}

/**
 * 层次聚类（平均连接 + 欧氏距离），返回 { order, tree }。
 *
 * 为什么放在宿主而不是渲染器：渲染器只画不算（和基因组学其他面板一个原则），
 * 顺序与树算好之后塞进面板定义，浏览器那边照着画，也便于在 Node 里断言。
 *
 * tree 的叶子是 `{ leaf: i, height: 0 }`，内部节点是 `{ height, children: [左, 右] }`；
 * `order` 是叶子在树里的左右顺序 —— 热图按它重排，图和树必然对齐。
 *
 * 复杂度 O(n³)：n=250 时约 1500 万次距离更新，可以接受。超过 maxN 返回 null，
 * 由调用方决定是放弃聚类还是提示 —— 悄悄降级比报错更坏，所以调用方必须处理 null。
 */
function hclust(vectors, maxN = 250) {
  const n = vectors.length
  if (n === 0) return null
  if (n === 1) return { order: [0], tree: { leaf: 0, height: 0 } }
  if (n > maxN) return null
  const dim = Math.max(...vectors.map((v) => v.length))
  const euclid = (a, b) => {
    let s = 0
    for (let i = 0; i < dim; i += 1) {
      const d = (a[i] || 0) - (b[i] || 0)
      s += d * d
    }
    return Math.sqrt(s)
  }
  let clusters = vectors.map((v, i) => ({ v, members: [i], size: 1, tree: { leaf: i, height: 0 } }))
  const dmap = new Map()
  const setD = (a, b, val) => {
    if (!dmap.has(a)) dmap.set(a, new Map())
    if (!dmap.has(b)) dmap.set(b, new Map())
    dmap.get(a).set(b, val)
    dmap.get(b).set(a, val)
  }
  for (let i = 0; i < clusters.length; i += 1) {
    for (let j = i + 1; j < clusters.length; j += 1) setD(clusters[i], clusters[j], euclid(clusters[i].v, clusters[j].v))
  }
  while (clusters.length > 1) {
    let bi = 0
    let bj = 1
    let best = Infinity
    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        const d = dmap.get(clusters[i]).get(clusters[j])
        if (d < best) { best = d; bi = i; bj = j }
      }
    }
    const A = clusters[bi]
    const B = clusters[bj]
    const merged = {
      v: A.v,
      // A 在左 B 在右：members 的顺序就是树的叶子顺序
      members: A.members.concat(B.members),
      size: A.size + B.size,
      tree: { height: best, children: [A.tree, B.tree] },
    }
    for (const c of clusters) {
      if (c === A || c === B) continue
      const da = dmap.get(A).get(c)
      const db = dmap.get(B).get(c)
      setD(merged, c, (A.size * da + B.size * db) / (A.size + B.size))
    }
    clusters = clusters.filter((c) => c !== A && c !== B)
    clusters.push(merged)
  }
  return { order: clusters[0].members, tree: clusters[0].tree }
}

/** 数叶子：Newick 里逗号数 + 1（任意分叉数都成立）。 */
const newickLeafCount = (s) => String(s || '').split(',').length

/** 把参数整理成一个基因组学面板。 */
function buildGenomicsPanel(args) {
  const kind = args.kind
  const title = args.title || {
    phylo: '进化树', msa: '多序列比对', enrich: 'GO / KEGG 富集',
    genome: '全基因组变异分布', coverage: '测序覆盖度', volcano: '差异表达火山图',
  }[kind] || kind

  if (kind === 'phylo') {
    if (!args.newick) throw new Error('phylo 需要 newick 参数（Newick 格式的树字符串）')
    return { panel: { kind: 'phylo', title, newick: args.newick, groups: args.groups || [], showSupport: args.showSupport }, summary: `${newickLeafCount(args.newick)} 个叶子` }
  }
  if (kind === 'msa') {
    const seqs = (args.sequences || []).filter((s) => s && s.seq)
    if (seqs.length < 2) throw new Error('msa 至少需要两条序列（sequences: [{name, seq}]）')
    const width = Math.max(...seqs.map((s) => String(s.seq).length))
    return { panel: { kind: 'msa', title, sequences: seqs, colorBy: args.colorBy || 'residue' }, summary: `${seqs.length} 条序列 × ${width} 列` }
  }
  if (kind === 'enrich') {
    const terms = (args.terms || []).filter((t) => t && t.term && isFinite(t.p))
    if (terms.length === 0) throw new Error('enrich 需要 terms: [{term, count, p, ratio?}]')
    const best = terms.slice().sort((a, b) => a.p - b.p)[0]
    const top = Math.min(terms.length, Math.max(3, args.top || 20))
    return {
      panel: { kind: 'enrich', title, terms, top },
      table: {
        columns: ['通路 / 条目', '基因数', '基因比例', 'p'],
        rows: terms.slice().sort((a, b) => a.p - b.p).slice(0, top).map((t) => [
          t.term, t.count ?? '', isFinite(t.ratio) ? Number(t.ratio).toFixed(3) : '', N.fmtP(t.p),
        ]),
      },
      summary: `共 ${terms.length} 条，最显著：${best.term}（p = ${N.fmtP(best.p)}）`,
    }
  }
  if (kind === 'genome') {
    const chroms = (args.chromosomes || []).filter((c) => c && c.name)
    if (chroms.length === 0) throw new Error('genome 需要 chromosomes: [{name, length}]')
    const variants = (args.variants || []).filter((v) => v && v.chrom)
    const byType = {}
    for (const v of variants) byType[v.type || 'SNP'] = (byType[v.type || 'SNP'] || 0) + 1
    const typeLine = Object.entries(byType).map(([k, n]) => `${k} ${n}`).join('、') || '无'
    return {
      panel: { kind: 'genome', title, chromosomes: chroms, variants },
      summary: `${chroms.length} 条染色体 · 变异 ${variants.length} 个（${typeLine}）`,
    }
  }
  if (kind === 'coverage') {
    const tracks = (args.tracks || []).filter((t) => t && t.points && t.points.length)
    if (tracks.length === 0) throw new Error('coverage 需要 tracks: [{name, points: [[pos, depth], ...]}]')
    let lo = Infinity
    let hi = -Infinity
    let peak = 0
    for (const t of tracks) {
      for (const p of t.points) {
        if (p[0] < lo) lo = p[0]
        if (p[0] > hi) hi = p[0]
        if (p[1] > peak) peak = p[1]
      }
    }
    return {
      panel: { kind: 'coverage', title, tracks, genes: args.genes || [] },
      summary: `${tracks.length} 条轨道 · 区间 ${N.fmt(lo, 0)}–${N.fmt(hi, 0)} · 峰值深度 ${N.fmt(peak, 0)}×`,
    }
  }
  if (kind === 'volcano') {
    const pts = (args.points || []).filter((p) => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]))
    if (pts.length === 0) throw new Error('volcano 需要 points: [[log2FC, -log10(p)], ...]')
    const lfcCut = args.lfcCutoff === undefined ? 1 : args.lfcCutoff
    const pCut = args.pCutoff === undefined ? 0.05 : args.pCutoff
    const logPCut = -Math.log10(pCut)
    const up = pts.filter((p) => p[1] >= logPCut && p[0] >= lfcCut).length
    const down = pts.filter((p) => p[1] >= logPCut && p[0] <= -lfcCut).length
    return {
      panel: {
        kind: 'volcano', title, points: pts, labels: args.labels || [],
        lfcCutoff: lfcCut, pCutoff: pCut,
        xLabel: args.xLabel || 'log2 倍数变化', yLabel: args.yLabel || '-log10(p)',
      },
      summary: `${pts.length} 个基因：上调 ${up}、下调 ${down}（|log2FC| ≥ ${lfcCut}，p < ${pCut}）`,
    }
  }
  if (kind === 'heatmap') {
    const rows = (args.values || []).filter((r) => Array.isArray(r))
    if (rows.length === 0) throw new Error('heatmap 需要 values：二维数字矩阵，如 [[1.2,-0.4],[0.8,1.9]]')
    const nRows = rows.length
    const nCols = Math.max(...rows.map((r) => r.length))
    const panel = {
      kind: 'heatmap',
      title,
      values: rows,
      rowLabels: args.rowLabels || [],
      colLabels: args.colLabels || [],
      palette: args.palette || 'redblue',
      scale: args.scale || 'centered',
      showValues: args.showValues === true,
    }
    const notes = []
    const wantRows = args.cluster === true || args.clusterRows === true
    const wantCols = args.cluster === true || args.clusterCols === true
    if (wantRows) {
      // 行向量 = 每一行（跨所有列）；缺值按 0 处理
      const r = hclust(rows.map((row) => Array.from({ length: nCols }, (_, c) => (isFinite(row[c]) ? row[c] : 0))))
      if (r) { panel.rowOrder = r.order; panel.rowTree = r.tree } else notes.push(`行数 ${nRows} 超过 ${250}，未做行聚类`)
    }
    if (wantCols) {
      const cols = Array.from({ length: nCols }, (_, c) => rows.map((row) => (isFinite(row[c]) ? row[c] : 0)))
      const r = hclust(cols)
      if (r) { panel.colOrder = r.order; panel.colTree = r.tree } else notes.push(`列数 ${nCols} 超过 ${250}，未做列聚类`)
    }
    if (args.showValues && nRows * nCols > 1200) notes.push('格子太多，数值标注已忽略')
    let lo = Infinity
    let hi = -Infinity
    for (const row of rows) for (const v of row) {
      if (!isFinite(v)) continue
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    return {
      panel,
      summary: `${nRows} × ${nCols} 矩阵，取值范围 ${N.fmt(lo, 2)} – ${N.fmt(hi, 2)}`
        + (panel.rowTree && panel.colTree ? '，行列均已聚类'
          : panel.rowTree ? '，已对行聚类' : panel.colTree ? '，已对列聚类' : '')
        + (notes.length ? `（${notes.join('；')}）` : ''),
    }
  }
  if (kind === 'network') {
    const rawNodes = (args.nodes || []).filter((nd) => nd && (nd.id !== undefined || nd.label !== undefined))
    if (rawNodes.length === 0) throw new Error('network 需要 nodes：[{ id, label?, group?, size? }]')
    const rawEdges = (args.edges || []).filter((e) => e && e.source !== undefined && e.target !== undefined)
    // 没给 size 就按度数补：连接多的节点自然该大一点
    const degree = new Map()
    for (const e of rawEdges) {
      degree.set(String(e.source), (degree.get(String(e.source)) || 0) + 1)
      degree.set(String(e.target), (degree.get(String(e.target)) || 0) + 1)
    }
    const nodes = rawNodes.map((nd) => {
      const key = String(nd.id ?? nd.label)
      return {
        id: key,
        label: nd.label ?? key,
        group: nd.group,
        size: Number(nd.size) || (degree.get(key) || 0) + 1,
        color: nd.color,
      }
    })
    const laid = networkLayout(nodes, rawEdges, {})
    const panel = {
      kind: 'network',
      title,
      nodes: nodes.map((nd, i) => ({ ...nd, x: laid.positions[i].x, y: laid.positions[i].y })),
      links: laid.links.map(([a, b, w]) => ({ source: nodes[a].id, target: nodes[b].id, weight: w })),
    }
    const groups = new Set(nodes.map((nd) => nd.group).filter(Boolean))
    return {
      panel,
      summary: `${nodes.length} 个节点 · ${laid.links.length} 条边`
        + (groups.size ? ` · ${groups.size} 个分组` : '')
        + (laid.dense ? `（节点超过 300，未做力导向布局，按环形铺开）` : ''),
    }
  }
  if (kind === 'logo') {
    const stat = logoColumns(args.logoSequences)
    if (!stat) throw new Error('logo 需要 logoSequences：[{ name?, seq }]，且序列不能为空')
    const panel = {
      kind: 'logo',
      title,
      columns: stat.columns,
      maxBits: stat.maxBits,
      yLabel: args.yLabel || '信息量 (bits)',
      subtitle: `${stat.n} 条序列 × ${stat.length} 列 · ${stat.isNt ? '核酸' : '蛋白'}（上限 ${N.fmt(stat.maxBits, 2)} bits）`,
    }
    const meanBits = stat.columns.reduce((s, c) => s + c.bits, 0) / stat.columns.length
    const conserved = stat.columns.filter((c) => c.bits > stat.maxBits * 0.85).length
    return {
      panel,
      summary: `${stat.n} 条序列 × ${stat.length} 列，平均信息量 ${N.fmt(meanBits, 2)} bits`
        + `（${stat.isNt ? '核酸' : '蛋白'}上限 ${N.fmt(stat.maxBits, 2)}），`
        + `其中 ${conserved} 列高度保守`,
    }
  }
  throw new Error(`不认识的 kind：${kind}`)
}

const genomicsTool = (state) => localTool({
  name: 'sci_viz_genomics',
  description:
    '基因组学可视化：把技能库里那些 DNA/RNA 分析的结果直接画出来，不用切到别的软件。' +
    'kind 可选：phylo（进化树，给 Newick 字符串）、msa（多序列比对，给已比对序列，画残基着色与保守度轨道）、' +
    'enrich（GO/KEGG 富集气泡图，给通路与 p 值）、genome（全基因组变异分布，给染色体与变异位点，画线性基因组图）、' +
    'coverage（测序覆盖度轨道，给 [位置, 深度] 与可选基因模型）、volcano（差异表达火山图，给 log2FC 与 -log10 p）。' +
    '这些图会推到同一个面板里，和三维结构、统计图表并列。',
  parameters: GENOMICS_PARAMS,
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'title', 'summary', 'panels'],
      properties: {
        ok: { type: 'boolean' },
        title: { type: 'string' },
        summary: { type: 'string' },
        panels: { type: 'integer' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.summary }],
  },
  async execute(args) {
    const { doc, value } = buildGenomicsDoc(args)
    await state.put(doc)
    return {
      ok: true,
      title: doc.title,
      summary: `${value.summary}。已在可视化窗口绘制「${doc.title}」`,
      panels: 1,
    }
  },
})

const skillsTool = (catalogRef, state) => localTool({
  name: 'sci_viz_skills',  description:
    '在「科研可视化」面板打开技能库浏览器。技能清单**随插件自带**（约 195 个，含完整 SKILL.md 正文），' +
    '插件挂载时已把它们全部注册进 DSH 的技能系统，所以可以直接调用其中任何一个。' +
    '本工具用于按关键词/分类/来源筛选并把面板切到技能页，也可以在窗口里高亮某个技能，' +
    '方便用户看到「这个技能在哪、能做什么」。返回匹配数量与前若干条。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', description: '关键词（匹配技能名、中文说明、正文英文描述）' },
      category: { type: 'string', description: '分类 id：structure / sequence / variant / chem / stats / viz / literature / method / tooling' },
      layer: { type: 'string', enum: ['ready', 'library'], description: '只看某一层' },
      focus: { type: 'string', description: '在窗口里高亮某个技能目录名' },
      limit: { type: 'integer', description: '返回条数上限，默认 12' },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'summary', 'matched', 'top'],
      properties: {
        ok: { type: 'boolean' },
        summary: { type: 'string' },
        matched: { type: 'integer' },
        top: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'layer', 'zh'],
            properties: {
              id: { type: 'string' },
              layer: { type: 'string' },
              zh: { type: 'string' },
            },
          },
        },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.summary }],
  },
  async execute(args) {
    const catalog = await catalogRef.get()
    const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(60, args.limit)) : 12
    const matched = filterSkills(catalog, args)
    const doc = {
      kind: 'skills',
      title: '技能库',
      query: args.query ?? '',
      category: args.category ?? '',
      layer: args.layer ?? '',
      focus: args.focus ?? '',
      counts: catalog.counts,
      pushedAt: Date.now(),
      /** 工具推来的视图：让浏览器半边主动把面板翻出来 */
      autoOpen: true,
    }
    await state.put(doc)
    const top = matched.slice(0, limit).map((s) => ({ id: s.id, layer: s.layer, zh: s.zh || s.description.slice(0, 60) }))
    const summary = matched.length === 0
      ? `没有匹配的技能（关键词 ${JSON.stringify(args.query ?? '')}）`
      : `技能清单共 ${catalog.counts.total} 个（即用 ${catalog.counts.ready} + 技能库 ${catalog.counts.library}），` +
        `本次匹配 ${matched.length} 个，前 ${top.length} 个：` +
        top.map((s) => `${s.id}[${s.layer === 'ready' ? '即用' : '库'}]`).join('、')
    return { ok: true, summary, matched: matched.length, top }
  },
})

function filterSkills(catalog, args) {
  const q = String(args.query ?? '').trim().toLowerCase()
  const cat = String(args.category ?? '').trim()
  const layer = String(args.layer ?? '').trim()
  return catalog.skills
    .filter((s) => (layer ? s.layer === layer : true))
    .filter((s) => (cat ? s.cat === cat : true))
    .filter((s) => {
      if (!q) return true
      return s.id.toLowerCase().includes(q) ||
        s.zh.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q))
    })
    .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id))
}

function chartTitle(kind) {
  const map = {
    normal: '正态分布', ttest: 't 检验', anova: '方差分析', chisq: '卡方检验',
    regression: '线性回归', power: '功效与样本量', descriptives: '描述统计', raw: '自定义图',
    survival: '生存分析', roc: 'ROC 曲线',
  }
  return map[kind] ?? '统计图'
}

// ---------------------------------------------------------------------------
// 插件体
// ---------------------------------------------------------------------------

/** 注册服务、路由与工具。 */
export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }
  const state = new VizState(config)

  /**
   * 浏览器半边的存活记录。
   *
   * 存在的理由很实际：客户端半边是挂在 document.body 上的浮窗，宿主看不到它有没有
   * 成功加载（slot 方案至少还能在槽位树里露个脸）。于是让浏览器半边每次轮询顺手
   * 报一次到，宿主记下来 —— 窗口没出现时，`GET /api/sci-viz/health` 一眼就能区分
   * 「半边没加载」和「加载了但没画出来」。
   */
  const health = {
    clientSeenAt: 0,
    clientHits: 0,
    clientBuild: '',
    hostStartedAt: Date.now(),
    /** 浏览器半边的自报：走到哪一步、有没有报错 —— 治「面板一片空白且毫无线索」。 */
    clientPhase: '',
    clientError: '',
    clientLog: [],
  }

  // 每个注册各自 try/catch：一个失败只让这一块降级，不拖垮整个 bundle 的挂载事务。
  const guard = (label, body) => {
    try {
      return ctx.effect(body, label)
    } catch (e) {
      ctx.logger?.warn?.(`dsh-sci-viz: ${label} 挂载失败：${e?.message ?? e}`)
      return () => {}
    }
  }

  // 技能清单以自带的包为主，叠加本地目录里多出来的技能；结果缓存 15 秒。
  let catalogCache = null
  let catalogAt = 0
  const getCatalog = async () => {
    if (catalogCache && Date.now() - catalogAt < 15000) return catalogCache
    catalogCache = await buildBundledCatalog(config)
    catalogAt = Date.now()
    return catalogCache
  }

  /**
   * 技能注册结果。放在 apply 作用域里，/health 会把它报出去 ——
   * 「对方装上后技能是否真的可用」靠它一眼确认，而不是靠猜。
   */
  let skillReg = { registered: 0, reason: '尚未注册' }

  guard('dsh-sci-viz: state dir', () => {
    void state.ensure()
    return () => {}
  })

  /**
   * 把技能注册进 DSH 的技能系统 —— **挂载时一次**，要生效就重启。
   *
   * 不在这里做「目录变了自动补注册」那套增量逻辑：宿主半边的改动本来就要重启才生效
   * （ESM 按 URL 缓存），为免重启加一层状态机不划算，代码越简单越不容易出错。
   *
   * 单独一个 guard：注册失败只影响「技能列不进 agent 技能表」，
   * 面板浏览、结构、统计都必须照常。
   */
  guard('dsh-sci-viz: skill registration', () => {
    let disposed = false
    getCatalog()
      .then(async (catalog) => {
        if (disposed) return
        const result = await registerSkills(ctx, catalog)
        skillReg = {
          ...result,
          total: catalog.counts.bundled,
          registry: await probeSkillRegistry(ctx, new Set(result.done ?? [])),
        }
        if (result.failures?.length) {
          ctx.logger?.warn?.(`dsh-sci-viz: ${result.failures.length} 个技能注册失败，首个：${result.failures[0]}`)
        }
      })
      .catch((e) => {
        skillReg = { registered: 0, reason: `注册过程出错：${e?.message ?? e}` }
      })
    return () => {
      disposed = true
    }
  })

  guard('dsh-sci-viz: routes', () => {
    const routes = [
      // ---- 面板自己发起的两件事：打开结构、跑统计 ----
      actionRoute(`${API}/open-structure`, async (body) => {
        const args = assertParams(STRUCTURE_PARAMS, body)
        const { doc, value } = await buildStructureDoc(args, config)
        const rev = await state.put(doc)
        return { rev, summary: value.summary, warnings: value.warnings, doc }
      }),
      actionRoute(`${API}/run-stats`, async (body) => {
        const args = assertParams(STATS_PARAMS, body)
        const { doc, value } = buildStatsDoc(args)
        const rev = await state.put(doc)
        return { rev, summary: value.summary, doc }
      }),
      actionRoute(`${API}/run-genomics`, async (body) => {
        // 面板上「粘贴文本 → 出图」那条路：文本解析放在宿主，客户端只负责发原文，
        // 这样解析逻辑可以在 Node 里直接断言，不用去驱动浏览器。
        const kind = String(body?.kind ?? '')
        if (!GENOMICS_KINDS.includes(kind)) {
          throw new Error(`kind 只能是 ${GENOMICS_KINDS.join(' / ')}，收到 "${kind}"`)
        }
        const args = { kind, ...parseGenomicsText(kind, String(body?.text ?? '')) }
        if (body?.title) args.title = String(body.title)
        if (body?.note) args.note = String(body.note)
        const { doc, value } = buildGenomicsDoc(args)
        const rev = await state.put(doc)
        return { rev, summary: value.summary, doc }
      }),
      actionRoute(`${API}/client-report`, async (body) => {
        // 浏览器半边的绘制回执：面板空白时靠它判断到底卡在哪一环
        health.clientPaint = {
          at: Date.now(),
          tab: body.tab ?? '',
          open: body.open === true,
          collapsed: body.collapsed === true,
          w: Number(body.w) || 0,
          h: Number(body.h) || 0,
          kind: String(body.kind ?? ''),
          panels: Number(body.panels) || 0,
          // 被跳过的面板数 + 这张图需要的高度：skipped>0 就说明画布矮了
          skipped: Number(body.skipped) || 0,
          needH: Number(body.needH) || 0,
          err: String(body.err ?? '').slice(0, 400),
        }
        if (health.clientPaint.err) {
          ctx.logger?.warn?.(`dsh-sci-viz: 绘制失败：${health.clientPaint.err}`)
        }
        return { ok: true }
      }),
      {
        kind: 'exact',
        path: `${API}/hello`,
        handler: (req, res) => {
          if (!isLoopback(req.socket?.remoteAddress ?? '')) {
            writeJson(res, 403, { ok: false, error: 'loopback only' })
            return
          }
          const url = new URL(req.url, 'http://127.0.0.1')
          health.clientSeenAt = Date.now()
          health.clientHits += 1
          health.clientBuild = url.searchParams.get('v') ?? ''
          // 分阶段自报：style/services/slots/launcher 走到哪一步、或在哪一步炸了
          const phase = url.searchParams.get('phase')
          if (phase) {
            /**
             * clientPhase 取「最靠后的那一步」，不是「最后到达的那一条」。
             *
             * 这几条回执是各自独立 fetch 的，到达顺序没有保证 —— 实测 apply-ok 与 apply-slots
             * 会在同一毫秒发出，而 apply-slots 后到，于是 /health 上显示成「apply() 没跑完」，
             * 让人以为面板坏了。这个字段本来就是为了排查空白面板，指向错误方向比没有更坏。
             */
            const rank = (p) => {
              if (p === 'apply-ok') return 4
              if (p.includes('error')) return 5
              if (p === 'apply-slots') return 3
              if (p === 'apply-services') return 2
              if (p === 'apply-start') return 1
              return 0
            }
            if (rank(phase) >= rank(health.clientPhase ?? '')) health.clientPhase = phase
            health.clientLog.push({ t: Date.now(), phase, err: url.searchParams.get('err') ?? '' })
            if (health.clientLog.length > 12) health.clientLog.shift()
            if (phase.includes('error')) {
              health.clientError = url.searchParams.get('err') ?? ''
              ctx.logger?.warn?.(`dsh-sci-viz: 浏览器半边在「${phase}」失败：${health.clientError}`)
            }
          }
          /**
           * 顺便把**真实 HTTP 地址**告诉浏览器半边。
           *
           * 桌面版渲染进程跑在 dsh-app:// 自定义协议下，`location.href` 拼出来的
           * 地址是 `dsh-app://app/...` —— 粘进浏览器根本打不开（用户实测过，粘到搜索引擎里了）。
           * 真地址在宿主这边：DSH_WEB_URL 环境变量；取不到就退回请求的 Host 头。
           */
          const origin = viewerOrigin(req)
          writeJson(res, 200, {
            ok: true,
            hostStartedAt: health.hostStartedAt,
            hits: health.clientHits,
            origin,
            viewer: origin ? `${origin}${API}/viewer` : '',
          })
        },
      },
      {
        kind: 'exact',
        path: `${API}/health`,
        handler: async (req, res) => {
          if (!isLoopback(req.socket?.remoteAddress ?? '')) {
            writeJson(res, 403, { ok: false, error: 'loopback only' })
            return
          }
          const current = await state.get()
          let catalog = null
          try {
            catalog = await getCatalog()
          } catch {
            catalog = null
          }
          writeJson(res, 200, {
            ok: true,
            hostStartedAt: health.hostStartedAt,
            hostUptimeMs: Date.now() - health.hostStartedAt,
            clientSeenAt: health.clientSeenAt,
            clientSeenAgoMs: health.clientSeenAt ? Date.now() - health.clientSeenAt : null,
            clientHits: health.clientHits,
            clientAlive: health.clientSeenAt > 0 && Date.now() - health.clientSeenAt < 20000,
            clientPhase: health.clientPhase,
            clientError: health.clientError,
            clientPaint: health.clientPaint ?? null,
            clientLog: health.clientLog.slice(-6),
            stateRev: current.rev,
            stateBytes: current.payload ? current.payload.length : 0,
            skills: catalog ? catalog.counts : null,
            pluginDir: HERE,
            /** 技能注册结果：对方机器上「装上就能用」的直接证据 */
            skillRegistration: skillReg,
            config: {
              skillPackPath: config.skillPackPath,
              skillsDirs: (config.skillsDirs ?? []).map((d) => d.dir),
              stateDir: config.stateDir,
              portable: !catalog || catalog.portable,
            },
          })
        },
      },
      {
        kind: 'exact',
        path: `${API}/state`,
        handler: async (req, res) => {
          if (!isLoopback(req.socket?.remoteAddress ?? '')) {
            writeJson(res, 403, { ok: false, error: 'loopback only' })
            return
          }
          const url = new URL(req.url, 'http://127.0.0.1')
          const since = Number(url.searchParams.get('rev') ?? '0')
          const current = await state.get()
          if (!current.payload) {
            writeJson(res, 200, { rev: 0, changed: false, doc: null })
            return
          }
          if (since && since === current.rev) {
            writeJson(res, 200, { rev: current.rev, changed: false })
            return
          }
          let doc = null
          try {
            doc = JSON.parse(current.payload).doc
          } catch {
            doc = null
          }
          writeJson(res, 200, { rev: current.rev, changed: true, doc })
        },
      },
      {
        /**
         * 独立窗口 viewer：一个自包含的页面，在浏览器里打开就能看当前可视化。
         *
         * 为什么要它：DSH 的 Electron 主进程对所有 window.open 都是 deny
         * （lib/main.js 里 setWindowOpenHandler(() => ({action:'deny'}))），
         * 所以插件内部弹不出真正的独立窗口。但宿主本来就有 HTTP 服务（且只绑回环），
         * 于是把面板做成一个页面 —— 用户在浏览器里打开，就能拖到聊天框旁边、
         * 或直接全屏丢到第二块屏。
         *
         * 页面不重写渲染器：它把 lib/client.js 当模块加载进来（同一份代码），
         * 用 __internals 里的 paintChart / paintStructure 画。渲染逻辑永远只有一份。
         */
        kind: 'exact',
        path: `${API}/viewer`,
        handler: (req, res) => {
          if (!isLoopback(req.socket?.remoteAddress ?? '')) {
            writeJson(res, 403, { ok: false, error: 'loopback only' })
            return
          }
          const html = renderViewerPage(API)
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(html)
        },
      },
      {
        /** 把浏览器半边的 bundle 原样吐出来，给 viewer 页面复用（见上面 /viewer 的说明）。 */
        kind: 'exact',
        path: `${API}/client.js`,
        handler: async (req, res) => {
          if (!isLoopback(req.socket?.remoteAddress ?? '')) {
            writeJson(res, 403, { ok: false, error: 'loopback only' })
            return
          }
          try {
            const url = new URL('./client.js', import.meta.url)
            const body = await readFile(url, 'utf8')
            res.writeHead(200, {
              'content-type': 'application/javascript; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(body)
          } catch (e) {
            writeJson(res, 500, { ok: false, error: `读不到 client.js：${e?.message ?? e}` })
          }
        },
      },
      {
        kind: 'exact',
        path: `${API}/clear`,
        handler: async (req, res) => {
          if (!isLoopback(req.socket?.remoteAddress ?? '')) {
            writeJson(res, 403, { ok: false, error: 'loopback only' })
            return
          }
          if (req.method !== 'POST') {
            writeJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const rev = await state.clear()
          writeJson(res, 200, { ok: true, rev })
        },
      },
      {
        kind: 'exact',
        path: `${API}/skills`,
        handler: async (req, res) => {
          if (!isLoopback(req.socket?.remoteAddress ?? '')) {
            writeJson(res, 403, { ok: false, error: 'loopback only' })
            return
          }
          const catalog = await getCatalog()
          writeJson(res, 200, {
            ok: true,
            version: catalog.version,
            snapshot: catalog.snapshot,
            portable: catalog.portable,
            categories: catalog.categories,
            layers: catalog.layers,
            counts: catalog.counts,
            skills: catalog.skills.map((s) => ({
              id: s.id,
              layer: s.layer,
              layerZh: s.layerZh,
              title: s.title,
              desc: s.description,
              zh: s.zh,
              cat: s.cat,
              viz: s.viz,
              tags: s.tags,
              weight: s.weight,
              bytes: s.bytes,
              readable: s.readable,
              hasScripts: s.hasScripts,
              hasReferences: s.hasReferences,
              /** 本机是否有这个技能的源目录（有的话详情能读附属资源） */
              localPath: s.localPath || '',
              resources: (s.resources || []).length,
            })),
          })
        },
      },
      {
        kind: 'exact',
        path: `${API}/skill`,
        handler: async (req, res) => {
          if (!isLoopback(req.socket?.remoteAddress ?? '')) {
            writeJson(res, 403, { ok: false, error: 'loopback only' })
            return
          }
          const url = new URL(req.url, 'http://127.0.0.1')
          const id = url.searchParams.get('id') ?? ''
          const layer = url.searchParams.get('layer') ?? 'ready'
          const catalog = await getCatalog()
          const skill = catalog.skills.find((s) => s.id === id && s.layer === layer)
          if (!skill) {
            writeJson(res, 404, { ok: false, error: `快照里没有这个技能：${layer}/${id}` })
            return
          }
          // 正文优先来自自带技能包（任何机器上都有），本机技能目录只用来补附属资源。
          let body = ''
          let available = false
          if (typeof skill.content === 'string' && skill.content) {
            const text = skill.content
            body = text.length > config.skillPreviewChars
              ? `${text.slice(0, config.skillPreviewChars)}\n\n...（正文共 ${text.length} 字符，窗口只预览前 ${config.skillPreviewChars} 字符）`
              : text
            available = true
          } else if (skill.readable && skill.path) {
            try {
              const text = await readFile(skill.path, 'utf8')
              body = text.length > config.skillPreviewChars
                ? `${text.slice(0, config.skillPreviewChars)}\n\n...（正文共 ${text.length} 字符，窗口只预览前 ${config.skillPreviewChars} 字符）`
                : text
              available = true
            } catch (e) {
              body = `读不到 SKILL.md：${e.message}`
            }
          } else if (skill.description) {
            body = `${skill.description}\n\n（这个技能只有说明，没有正文。）`
          } else {
            body = '（这个技能没有可显示的正文。）'
          }
          writeJson(res, 200, {
            ok: true,
            id: skill.id,
            layer: skill.layer,
            title: skill.title,
            zh: skill.zh,
            cat: skill.cat,
            tags: skill.tags,
            path: skill.path,
            dir: skill.dir,
            hasScripts: skill.hasScripts,
            hasReferences: skill.hasReferences,
            bytes: skill.bytes,
            available,
            body,
          })
        },
      },
    ]
    const disposers = routes.map((r) => ctx.webServer.register(r))
    return () => {
      for (const dispose of disposers) dispose()
    }
  })

  guard('dsh-sci-viz: tools', () => {
    const tools = ctx.get('tools')
    if (!tools?.register) return () => {}
    // 技能工具需要一份「取用时才刷新」的目录视图（顶层 await 拿不到，挂载不该等磁盘）
    const catalogRef = { get: getCatalog }
    const disposers = [
      tools.register(structureTool(state, config)),
      tools.register(statsTool(state)),
      tools.register(plotTool(state)),
      tools.register(genomicsTool(state)),
      tools.register(skillsTool(catalogRef, state)),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  })

  /**
   * 验证规程：一段系统提示 + 一道子代理守卫。
   * 跟着插件走，所以分享出去对方也拿得到；不需要任何运行时探测。
   * 只用运行期算出的路径（插件目录 / stateDir），换台机器自动是对方的路径。
   */
  guard('dsh-sci-viz: verify-protocol', () =>
    applyVerifyProtocol(ctx, config.verifyProtocol, { pluginDir: HERE, stateDir: config.stateDir }),
  )

  // 预热技能目录，让打开窗口时第一屏就有内容（失败不影响挂载）
  void getCatalog().catch(() => {})
}
