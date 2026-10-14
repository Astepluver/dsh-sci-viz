/**
 * 宿主半边集成冒烟测试。
 *
 * 用一个假的 cordis ctx 挂载 lib/index.js，然后：
 *   1. 检查 4 个工具都注册成功，且 schema 满足 dsh-tools 的原始 JSON Schema 子集
 *   2. 逐个调用工具的 execute（结构用本地文件，统计用合成数据）
 *   3. 检查路由注册成功，并用假 req/res 实际打一遍
 *   4. **重点**：验证「不依赖本地技能包」—— 不配 skillsDirs 时技能清单仍然完整，
 *      配上之后才多出 SKILL.md 正文
 *
 * 用法：node tools/smoke-host.mjs
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'sciviz-smoke-'))

/** 一次可复用的假 ctx 挂载。 */
function makeHarness() {
  const routes = new Map()
  const tools = new Map()
  const effects = []
  const logs = []
  /** 假技能注册表：记录插件往 DSH 技能系统里注册了什么 */
  const registered = []
  const ctx = {
    logger: { warn: (m) => logs.push(`warn: ${m}`), info: (m) => logs.push(`info: ${m}`), error: (m) => logs.push(`error: ${m}`) },
    effect(body, label) {
      const dispose = body()
      effects.push({ label, dispose })
      return dispose
    },
    get(name) {
      if (name === 'tools') {
        return {
          register(def) {
            tools.set(def.name, def)
            return () => tools.delete(def.name)
          },
        }
      }
      if (name === 'skills') {
        return {
          register(skill) {
            if (registered.some((s) => s.name === skill.name)) throw new Error(`duplicate skill ${skill.name}`)
            registered.push(skill)
            return () => {}
          },
          /** 技能系统自己的视角：/health 用它给出「装上就能用」的可自证证据 */
          async list() {
            return registered.map((s) => ({
              name: s.name,
              description: s.description,
              source: s.source,
              provider: 'dsh-sci-viz',
            }))
          },
        }
      }
      return undefined
    },
    webServer: {
      register(route) {
        const key = `${route.kind}:${route.path}`
        if (routes.has(key)) throw new Error(`duplicate route ${key}`)
        routes.set(key, route)
        return () => routes.delete(key)
      },
    },
  }
  const fakeReq = (url, method = 'GET') => ({ url, method, socket: { remoteAddress: '127.0.0.1' } })
  const callRoute = async (path, method = 'GET', address = '127.0.0.1', body) => {
    const route = routes.get(`exact:${path.split('?')[0]}`)
    if (!route) throw new Error(`没有注册路由 ${path}`)
    let status = 0
    let payload = ''
    const res = {
      writeHead(s) { status = s },
      end(p) { payload = p ?? '' },
    }
    // 假 req：给 POST 提供最小的流接口（on('data') / on('end')），否则 readJsonBody 会挂住
    const req = { url: path, method, socket: { remoteAddress: address } }
    if (body !== undefined) {
      const handlers = {}
      req.on = (evt, fn) => {
        handlers[evt] = fn
        return req
      }
      req.destroy = () => {}
      const buf = Buffer.from(JSON.stringify(body), 'utf8')
      queueMicrotask(() => {
        if (handlers.data) handlers.data(buf)
        if (handlers.end) handlers.end()
      })
    }
    await route.handler(req, res)
    return { status, json: payload ? JSON.parse(payload) : null }
  }
  /** 取原始响应体（HTML / JS 这类非 JSON 路由用）。 */
  const callRaw = async (path) => {
    const route = routes.get(`exact:${path.split('?')[0]}`)
    if (!route) throw new Error(`没有注册路由 ${path}`)
    let status = 0
    let text = ''
    const res = {
      writeHead(s) { status = s },
      end(p) { text = String(p ?? '') },
    }
    await route.handler({ url: path, method: 'GET', socket: { remoteAddress: '127.0.0.1' } }, res)
    return { status, text }
  }
  const run = async (name, args) => {
    const def = tools.get(name)
    if (!def) throw new Error(`没有工具 ${name}`)
    const value = await def.execute(args, {})
    return { value, def, rendered: def.output.render(args, value) }
  }
  return { routes, tools, effects, logs, ctx, callRoute, callRaw, run, registered }
}

let failures = 0
const ok = (cond, label, detail = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures += 1
}

/**
 * 有些检查需要本机才有的东西：测试用的 AlphaFold 结构文件、用户自己的技能目录。
 * 公开仓库里不带这些文件，缺了就把对应检查标成「跳过」并如实计数 ——
 * 不能让一个换了台机器就跑红的自检，把「有测试」变成摆设。
 */
const skipped = []
/**
 * 显式设了 SCIVIZ_FIXTURES 却找不到文件 = 配置错了，要报失败；
 * 只有「没设环境变量」才允许跳过 —— 否则真实失败会被静默吞掉。
 */
const skip = (label, why) => {
  if (FIXTURES_SET) {
    failures += 1
    console.log(` FAIL  ${label} — ${why}（已显式设置 SCIVIZ_FIXTURES，缺失即失败）`)
    return
  }
  skipped.push({ label, why })
  console.log(`  跳过  ${label} — ${why}`)
}
/** 本机测试数据目录；换台机器用 SCIVIZ_FIXTURES 指过去即可跑满。 */
const FIXTURES = process.env.SCIVIZ_FIXTURES || '<测试数据目录>'
const FIXTURES_SET = Boolean(process.env.SCIVIZ_FIXTURES)
const fixture = (rel) => join(FIXTURES, rel)
const hasFixture = (rel) => existsSync(fixture(rel))

/**
 * 技能目录：公开仓库里没有「本机技能库」，缺失时挂载仍照常做，
 * 只是不再断言「包内技能关联到了本地资源目录」。
 * 想用自己的技能目录跑这一段：SCIVIZ_SKILL_DIRS="D:\a;D:\b"
 */
const SKILL_DIRS_DEFAULT = [
  { dir: '<技能目录>', layer: 'ready', zh: '即用层' },
  { dir: '<技能库目录>', layer: 'library', zh: '技能库层' },
]
const skillDirsFromEnv = (process.env.SCIVIZ_SKILL_DIRS || '').split(';').filter(Boolean)
const LOCAL_SKILL_DIRS = (skillDirsFromEnv.length
  ? skillDirsFromEnv.map((d) => ({ dir: d, layer: 'library', zh: '自建' }))
  : SKILL_DIRS_DEFAULT
).filter((d) => existsSync(d.dir))

// ---- 复刻 dsh-tools 的 assertSupportedJsonSchema（原始子集） ---------------
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const CONSTRAINT = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATION = new Set(['description', 'title', 'default', 'examples', '$comment', 'deprecated', 'readOnly', 'writeOnly'])

function assertSupported(schema, path = 'schema', violations = []) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    violations.push(`${path} 必须是对象`)
    return violations
  }
  for (const key of Object.keys(schema)) {
    if (!CONSTRAINT.has(key) && !ANNOTATION.has(key)) violations.push(`${path}.${key} 不是支持的键`)
  }
  const hasType = Object.hasOwn(schema, 'type')
  const hasOneOf = Object.hasOwn(schema, 'oneOf')
  if (hasType && hasOneOf) {
    violations.push(`${path} 不能同时有 type 与 oneOf`)
    return violations
  }
  if (!hasType && !hasOneOf) return violations
  if (hasOneOf) {
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length < 2) violations.push(`${path}.oneOf 至少 2 项`)
    else schema.oneOf.forEach((s, i) => assertSupported(s, `${path}.oneOf[${i}]`, violations))
    return violations
  }
  if (!SCHEMA_TYPES.includes(schema.type)) {
    violations.push(`${path}.type 非法：${schema.type}`)
    return violations
  }
  if (Object.hasOwn(schema, 'required')) {
    if (!Array.isArray(schema.required) || schema.required.some((k) => typeof k !== 'string')) {
      violations.push(`${path}.required 必须是字符串数组`)
    } else if (schema.properties) {
      for (const key of schema.required) {
        if (!Object.hasOwn(schema.properties, key)) violations.push(`${path}.required 提到未声明的 ${key}`)
      }
    }
  }
  if (Object.hasOwn(schema, 'additionalProperties') && typeof schema.additionalProperties !== 'boolean') {
    violations.push(`${path}.additionalProperties 必须是布尔`)
  }
  if (Object.hasOwn(schema, 'enum') && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    violations.push(`${path}.enum 必须是非空数组`)
  }
  if (schema.properties) {
    for (const [key, sub] of Object.entries(schema.properties)) assertSupported(sub, `${path}.properties.${key}`, violations)
  }
  if (schema.items) assertSupported(schema.items, `${path}.items`, violations)
  return violations
}

/** 复刻 registry 对返回值的校验。 */
function validateValue(schema, value, path = 'value') {
  const bad = []
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object') return [`${path} 不是对象`]
    for (const key of schema.required ?? []) if (value[key] === undefined) bad.push(`缺 ${path}.${key}`)
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties ?? {}, key)) bad.push(`多出 ${path}.${key}`)
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (value[key] !== undefined) bad.push(...validateValue(sub, value[key], `${path}.${key}`))
    }
    return bad
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${path} 不是数组`]
    return schema.items ? value.flatMap((v, i) => validateValue(schema.items, v, `${path}[${i}]`)) : []
  }
  if (schema.type === 'string') return typeof value === 'string' ? [] : [`${path} 不是字符串`]
  if (schema.type === 'integer') return Number.isInteger(value) ? [] : [`${path} 不是整数`]
  if (schema.type === 'number') return Number.isFinite(value) ? [] : [`${path} 不是数字`]
  if (schema.type === 'boolean') return typeof value === 'boolean' ? [] : [`${path} 不是布尔`]
  return []
}

const { apply } = await import('../lib/index.js')

// ===========================================================================
console.log('== 挂载 A：便携模式（不配 skillsDirs，模拟换了台机器只有插件目录）==')
const A = makeHarness()
apply(A.ctx, { stateDir: join(sandbox, 'state-a') })
await new Promise((r) => setTimeout(r, 600))
ok(A.routes.size === 12, `注册了 ${A.routes.size} 条路由`)
ok(A.tools.size === 5, `注册了 ${A.tools.size} 个工具`, [...A.tools.keys()].join(' / '))

console.log('\n== 工具 schema 校验 ==')
for (const [name, def] of A.tools) {
  const v1 = assertSupported(def.parameters, `${name}.parameters`)
  const v2 = assertSupported(def.output.schema, `${name}.output.schema`)
  ok(v1.length === 0 && v2.length === 0, `${name} schema 合法`, [...v1, ...v2].slice(0, 3).join('；'))
  ok(typeof def.description === 'string' && def.description.length > 20, `${name} 有描述`)
}

console.log('\n== 便携模式的技能清单 ==')
{
  const skills = await A.callRoute('/api/sci-viz/skills')
  ok(skills.json.ok, '/skills 可用')
  ok(skills.json.skills.length === 195, `返回 ${skills.json.skills.length} 个技能（来自插件自带的包）`)
  ok(skills.json.portable === true, 'portable = true（没有任何本地技能目录）')
  ok(skills.json.counts.bundled === 195, `counts.bundled = ${skills.json.counts.bundled}（全部来自包）`)
  ok(skills.json.counts.readable === 195, `counts.readable = ${skills.json.counts.readable}（正文都可读）`)
  ok(skills.json.categories.length === 9, `${skills.json.categories.length} 个分类（分类表也在包里）`)
  const withZh = skills.json.skills.filter((s) => s.zh).length
  const withDesc = skills.json.skills.filter((s) => s.desc).length
  ok(withZh === 195, `中文说明 ${withZh}/195`)
  ok(withDesc === 195, `英文说明 ${withDesc}/195`)

  // 正文：没有本地目录也必须能读到
  const one = await A.callRoute('/api/sci-viz/skill?id=pymol&layer=bundled')
  ok(one.status === 200 && one.json.ok, '没有技能目录时 /skill 仍返回 200')
  ok(one.json.available === true, 'available = true（正文来自技能包）')
  ok(one.json.body.length > 1000, `读到正文 ${one.json.body.length} 字符`)
  ok(/PyMOL|pymol/.test(one.json.body), '正文内容确实是 PyMOL 技能')
}

// ===========================================================================
console.log('\n== 分享出去就能用：技能是否真的注册进了 DSH ==')
{
  // 等注册的异步链跑完
  await new Promise((r) => setTimeout(r, 900))
  const reg = A.registered
  ok(reg.length === 195, `注册了 ${reg.length} 个技能到 DSH 技能系统`)

  const sample = reg.find((s) => s.name === 'pymol')
  ok(!!sample, '按 kebab-case 名字注册（pymol）')
  if (sample) {
    ok(typeof sample.content === 'string' && sample.content.length > 1000,
      `携带完整正文 ${sample.content.length} 字符`)
    ok(typeof sample.description === 'string' && sample.description.length > 10, '有 description（技能表里显示的）')
    ok(sample.source === 'bundled', `source = ${sample.source}（SkillSource 里的合法值）`)
    ok(sample.invocation && sample.invocation.modelInvocable === true, 'invocation.modelInvocable = true（AI 可直接调用）')
    ok(!!sample.resourceBase, `resourceBase = ${JSON.stringify(sample.resourceBase)}`)
  }
  // 名字必须是 kebab-case（DSH 的约定），不能带下划线
  const underscored = reg.filter((s) => s.name.includes('_'))
  ok(underscored.length === 0, `没有下划线名字（${underscored.slice(0, 3).map((s) => s.name).join(', ')}）`)
  // 每个都要有正文，否则注册了也用不了
  const noContent = reg.filter((s) => !s.content || s.content.length < 50)
  ok(noContent.length === 0, `每个技能都带正文（空正文 ${noContent.length} 个）`)

  const h = await A.callRoute('/api/sci-viz/health')
  ok(h.json.skillRegistration && h.json.skillRegistration.registered === 195,
    `/health 报告注册数 ${h.json.skillRegistration?.registered}`)
  // 可自证：技能系统自己被问一遍，认得多少个来自本插件的技能
  const probe = h.json.skillRegistration?.registry
  ok(probe && probe.bundled === 195, `技能系统自查：${probe?.bundled} 个 source='bundled'，共 ${probe?.total} 条`)
  // 按名字核对：这个字段曾经按 provider 过滤，而 DSH 不填插件名，结果永远是 0
  ok(probe && probe.ours === 195 && probe.oursExpected === 195,
    `按名字核对：${probe?.ours}/${probe?.oursExpected} 个注册的技能确实在技能表里`)
  ok(!h.json.skillRegistration?.reason, `没有降级原因（${h.json.skillRegistration?.reason ?? '无'}）`)
}

// 没有 ctx.skills 的 DSH 也要能降级：面板照常，只是技能注册不上
{
  const D = makeHarness()
  D.ctx.get = ((orig) => (n) => (n === 'skills' ? undefined : orig(n)))(D.ctx.get)
  apply(D.ctx, { stateDir: join(sandbox, 'state-d') })
  await new Promise((r) => setTimeout(r, 700))
  const h = await D.callRoute('/api/sci-viz/health')
  ok(h.json.ok && h.json.skills.total === 195, '没有 skills 服务时面板清单照常（195 个）')
  ok(/skills 服务不可用/.test(h.json.skillRegistration?.reason ?? ''),
    `/health 如实说明：${h.json.skillRegistration?.reason}`)
}

// ===========================================================================
console.log('\n== 挂载 B：配了 skillsDirs（本机形态）==')
const B = makeHarness()
apply(B.ctx, {
  stateDir: join(sandbox, 'state-b'),
  skillsDirs: LOCAL_SKILL_DIRS,
})
await new Promise((r) => setTimeout(r, 900))
ok(B.routes.size === 12 && B.tools.size === 5, `工具与路由照常注册（${B.routes.size} 条路由 / ${B.tools.size} 个工具）`)
{
  const skills = await B.callRoute('/api/sci-viz/skills')
  const total = skills.json.skills.length
  const bundled = skills.json.counts.bundled
  const local = skills.json.counts.local
  /**
   * 这里不能写死总数：本机的技能目录里可能有插件包里没有的技能（用户自己加的、
   * 或 DSH 自带的插件开发技能），那正是「本地目录补充技能」这个功能在生效 ——
   * 实测本机就有 11 个额外技能（plugin-write / plugin-release / dsh-upgrade-audit …）。
   * 写死 195 会让这个测试在任何人加过技能之后误报。
   */
  ok(bundled === 195, `包内技能仍是 ${bundled} 个（不因本机有目录而重复或丢失）`)
  ok(total === 195 + local, `总数 ${total} = 包内 195 + 本地 ${local}（本机目录里多出来的都列出来了）`)
  ok(skills.json.counts.readable === total, `readable = ${skills.json.counts.readable}/${total}（全部可读）`)
  // 本机有目录时，包内技能应当记下 localPath，详情才能读到 scripts/references
  if (local > 0) {
    const withLocal = skills.json.skills.filter((s) => s.layer === 'bundled' && s.localPath)
    ok(withLocal.length === 195, `包内 ${withLocal.length}/195 关联到了本地资源目录`)
  } else {
    skip('包内技能关联本地资源目录', `本机没有配置里的技能目录（${LOCAL_SKILL_DIRS.length} 个命中）`)
  }
  const one = await B.callRoute('/api/sci-viz/skill?id=pymol&layer=bundled')
  ok(one.json.available === true && one.json.body.length > 500, `/skill 读到正文 ${one.json.body.length} 字符`)
  const short = await B.callRoute('/api/sci-viz/skill?id=not-exist&layer=bundled')
  ok(short.status === 404, '包里没有的技能返回 404')
}

// 本地目录里多出来的技能要被列出来（用户后续自己加技能就是这条路）
{
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'sciviz-extra-skill-'))
  mkdirSync(join(dir, 'my-new-skill'), { recursive: true })
  writeFileSync(join(dir, 'my-new-skill', 'SKILL.md'),
    '---\nname: my-new-skill\ndescription: A skill added later by the user.\n---\n\n# My New Skill\n\nDo the thing.\n', 'utf8')
  const C = makeHarness()
  apply(C.ctx, { stateDir: join(sandbox, 'state-c'), skillsDirs: [{ dir, layer: 'library', zh: '自建' }] })
  await new Promise((r) => setTimeout(r, 900))
  const skills = await C.callRoute('/api/sci-viz/skills')
  const extra = skills.json.skills.find((s) => s.id === 'my-new-skill')
  ok(!!extra, `本地新加的技能出现在清单里（共 ${skills.json.skills.length} 个）`)
  ok(extra && extra.layer === 'local', `它的 layer = ${extra && extra.layer}（与自带的区分开）`)
  ok(await (async () => {
    const one = await C.callRoute('/api/sci-viz/skill?id=my-new-skill&layer=local')
    return one.json.available === true && /Do the thing/.test(one.json.body)
  })(), '点开能读到它的正文')
}

// ===========================================================================
console.log('\n== 面板自己发起的操作（「即用」的核心）==')
{
  // 独立窗口页面：能生成、没有残留模板占位、页面自己的 JS 语法正确、渲染器能取到
  const page = await A.callRaw('/api/sci-viz/viewer')
  ok(page.status === 200 && page.text.startsWith('<!doctype html>'), `独立窗口页面 ${page.text.length} 字节`)
  ok(!page.text.includes('${'), '页面里没有残留的 ${ 占位符（模板串被截断过就会留）')
  ok(page.text.includes('window.__ModuleLoader__'), '页面给 bundle 塞了最小加载器')
  ok(page.text.includes('/api/sci-viz/client.js'), '页面复用宿主吐出的 client.js（渲染器只有一份）')
  const scripts = [...page.text.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  let scriptErr = ''
  for (const code of scripts) {
    try { new Function(code) } catch (e) { scriptErr = e.message }
  }
  ok(scriptErr === '' && scripts.length >= 2, `页面内联脚本 ${scripts.length} 段，语法全部正确${scriptErr ? '：' + scriptErr : ''}`)
  const cj = await A.callRaw('/api/sci-viz/client.js')
  ok(cj.status === 200 && cj.text.includes('__ModuleLoader__') && cj.text.includes('__internals'),
    `client.js 路由可读（${Math.round(cj.text.length / 1024)} KB，含 __internals）`)
  // 只绑回环：非本机地址必须被拒
  const route = A.routes.get('exact:/api/sci-viz/viewer')
  let denied = 0
  await route.handler({ url: '/api/sci-viz/viewer', method: 'GET', socket: { remoteAddress: '10.0.0.9' } }, {
    writeHead(s) { denied = s }, end() {},
  })
  ok(denied === 403, `viewer 只允许回环访问（外部地址得到 ${denied}）`)

  // 基因组页「粘贴文本 → 出图」：文本解析在宿主，所以能在这里直接断言
  const cases = [
    ['phylo', '((H37Rv:0.1,L2:0.12)90:0.2,(L4:0.15,L5:0.18)80:0.16);', /个叶子/],
    ['msa', '>a\nMKTV\n>b\nMKTA\n>c\nMRTV', /3 条序列/],
    ['enrich', 'term\tcount\tp\tcategory\nABC transporters\t24\t3.1e-9\tKEGG', /共 1 条/],
    ['volcano', 'gene\tlfc\tp\nkatG\t4.8\t7.9\ninhA\t-3.6\t6.2', /2 个基因/],
    ['coverage', 'H37Rv\n0\t120\n100\t135', /1 条轨道/],
    ['heatmap', '\tS1\tS2\nkatG\t2.1\t1.8\ninhA\t-1.9\t-2.2', /2 × 2 矩阵/],
    ['genome', 'chrom\tpos\ttype\tlabel\nchr\t2153889\tSNP\tkatG S315T', /1 条染色体/],
    ['logo', '>a\nACGT\n>b\nACGA\n>c\nACGT', /3 条序列/],
    ['network', 'katG\tinhA\nkatG\tahpC\ninhA\tahpC', /3 个节点 · 3 条边/],
  ]
  for (const [kind, text, want] of cases) {
    const r = await A.callRoute('/api/sci-viz/run-genomics', 'POST', '127.0.0.1', { kind, text })
    ok(r.status === 200 && want.test(r.json.summary ?? ''), `粘贴文本出图：${kind} —— ${String(r.json.summary ?? r.json.error).slice(0, 52)}`)
  }
  // 面板上「示例」按钮填的那些数据必须真能跑通 —— 示例跑不通比没有示例更糟。
  // 直接从 client.js 里抠出 GENOME_DEMOS 对象字面量（纯字符串，无函数），逐条喂真实路由。
  {
    const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    const start = src.indexOf('const GENOME_DEMOS = {')
    if (start < 0) throw new Error('client.js 里找不到 GENOME_DEMOS')
    const end = src.indexOf('\n      }\n', start)
    if (end < 0) throw new Error('找不到 GENOME_DEMOS 的结尾')
    const literal = src.slice(start + 'const GENOME_DEMOS = '.length, end + '\n      }'.length)
    const demos = new Function(`return ${literal}`)()
    const kinds = Object.keys(demos)
    ok(kinds.length === 9, `示例按钮覆盖 ${kinds.length} 种类型（应 9 种）：${kinds.join('/')}`)
    for (const k of kinds) {
      const r = await A.callRoute('/api/sci-viz/run-genomics', 'POST', '127.0.0.1', { kind: k, text: demos[k].text, title: demos[k].title })
      ok(r.status === 200, `示例可跑通：${k} —— ${String(r.json.summary ?? r.json.error).slice(0, 50)}`)
    }
  }

  // 解析失败必须是能读懂的话，而不是抛栈
  const badText = await A.callRoute('/api/sci-viz/run-genomics', 'POST', '127.0.0.1', { kind: 'msa', text: '>a\nMKTV\n>b\nMKTVA' })
  ok(badText.status === 400 && /长度不一致/.test(badText.json.error ?? ''), `粘贴错误数据给的是人话：${String(badText.json.error).slice(0, 44)}`)
  const badKind = await A.callRoute('/api/sci-viz/run-genomics', 'POST', '127.0.0.1', { kind: 'nope', text: 'x' })
  ok(badKind.status === 400, '非法 kind 被拒绝')

  // 力导向布局不能带随机数：同样的输入必须给出同样的坐标，否则每次调用图都在变
  const netText = 'a\tb\nb\tc\nc\td\nd\ta\nb\td'
  const readNodes = () => JSON.parse(readFileSync(join(sandbox, 'state-a', 'current.json'), 'utf8'))
    .doc.panels[0].nodes.map((nd) => `${nd.x.toFixed(4)},${nd.y.toFixed(4)}`).join('|')
  await A.callRoute('/api/sci-viz/run-genomics', 'POST', '127.0.0.1', { kind: 'network', text: netText })
  const pos1 = readNodes()
  await A.callRoute('/api/sci-viz/run-genomics', 'POST', '127.0.0.1', { kind: 'network', text: netText })
  const pos2 = readNodes()
  ok(pos1.split('|').every((p) => isFinite(parseFloat(p.split(',')[0]))), `网络布局坐标都是有限数（${pos1.split('|').length} 个节点）`)
  ok(pos1 === pos2, '同一份网络两次布局坐标完全一致（力导向无随机数）')

  // Logo：间隙不参与统计 —— 把 gap 算进去会把保守列的信息量压低，是常见错法。
  // 第 2 列是「- G G」：排除 gap 后只剩一种字母 → 信息量正好是上限 2；
  // 若把 gap 当字母（G 2/3、gap 1/3）则只有 1.08 bits，两者可区分。
  await A.callRoute('/api/sci-viz/run-genomics', 'POST', '127.0.0.1', {
    kind: 'logo', text: '>a\nA-C\n>b\nAGC\n>c\nAGC',
  })
  const lgDoc = JSON.parse(readFileSync(join(sandbox, 'state-a', 'current.json'), 'utf8')).doc
  const col2 = lgDoc.panels[0].columns[1]
  ok(Math.abs(col2.bits - 2) < 1e-9,
    `Logo 间隙被排除：第 2 列全为 G，信息量 ${col2.bits.toFixed(4)} = 上限 2（把 gap 算进去会明显偏低）`)
  ok(lgDoc.panels[0].subtitle.includes('核酸'), `Logo 自动识别字母表：${lgDoc.panels[0].subtitle}`)

  // 面板上点「打开结构」走的就是这条路由，与工具共用 buildStructureDoc
  if (hasFixture('AF_O53740.pdb')) {
    const opened = await A.callRoute('/api/sci-viz/open-structure', 'POST', '127.0.0.1', {
      source: fixture('AF_O53740.pdb'),
      style: 'ballstick',
      colorBy: 'element',
      termini: true,
      label: '面板打开测试',
    })
    ok(opened.status === 200 && opened.json.ok, 'POST /open-structure 成功', opened.json && opened.json.error)
    ok(opened.json.doc && opened.json.doc.kind === 'structure', '返回了结构文档')
    ok(opened.json.doc.view.termini === true && opened.json.doc.view.style === 'ballstick',
      '视图参数被采纳（termini/style）')
    ok(Number.isFinite(opened.json.rev) && opened.json.rev > 0, `返回版本号 ${opened.json.rev}（面板用它对齐 watcher）`)
    console.log(`       ${String(opened.json.summary).slice(0, 120)}`)
  } else {
    skip('POST /open-structure 成功（4 项）',
      `缺 ${FIXTURES}/AF_O53740.pdb —— 设 SCIVIZ_FIXTURES=<目录> 可跑满`)
  }

  // 面板上点「运行」走这条
  const ran = await A.callRoute('/api/sci-viz/run-stats', 'POST', '127.0.0.1', {
    kind: 'ttest',
    groups: [{ label: 'A', values: [8.2, 7.9, 8.5, 8.1, 7.7] }, { label: 'B', values: [7.1, 6.8, 7.4, 7.0, 6.6] }],
  })
  ok(ran.status === 200 && ran.json.ok, 'POST /run-stats 成功', ran.json && ran.json.error)
  ok(ran.json.doc && ran.json.doc.kind === 'chart' && ran.json.doc.panels.length > 0,
    `返回图表文档，${ran.json.doc && ran.json.doc.panels.length} 个面板`)
  // 「做完统计自动把面板拉出来」：浏览器半边靠这个记号决定翻页
  ok(ran.json.doc.autoOpen === true, '图表文档带 autoOpen（浏览器半边据此主动翻页）')

  // 参数错误必须是 400 + 一句人话，而不是 500
  const bad = await A.callRoute('/api/sci-viz/run-stats', 'POST', '127.0.0.1', { kind: 'nope' })
  ok(bad.status === 400 && !bad.json.ok, `非法 kind 返回 400：${bad.json.error}`)
  const badSource = await A.callRoute('/api/sci-viz/open-structure', 'POST', '127.0.0.1', {
    source: 'C:/definitely/not/here.pdb',
  })
  ok(badSource.status === 400 && /找不到结构文件/.test(badSource.json.error || ''),
    `找不到文件时给出可读错误：${String(badSource.json.error).slice(0, 60)}`)
  const wrongMethod = await A.callRoute('/api/sci-viz/run-stats', 'GET')
  ok(wrongMethod.status === 405, 'GET 这两个路由返回 405')
  const remotePost = await A.callRoute('/api/sci-viz/run-stats', 'POST', '10.0.0.5', { kind: 'ttest', values: [1, 2, 3] })
  ok(remotePost.status === 403, '非本机地址拒绝（403）')

  // 绘制回执：浏览器半边报告「我看到了什么」，面板空白时靠它定位
  const paint = await A.callRoute('/api/sci-viz/client-report', 'POST', '127.0.0.1', {
    tab: 'chart', open: true, collapsed: false, w: 1043, h: 612, kind: 'chart', panels: 3, err: '',
  })
  ok(paint.status === 200 && paint.json.ok, 'POST /client-report 成功')
  const h2 = await A.callRoute('/api/sci-viz/health')
  ok(h2.json.clientPaint && h2.json.clientPaint.w === 1043 && h2.json.clientPaint.panels === 3,
    `/health 里能看到绘制回执（${h2.json.clientPaint?.tab} ${h2.json.clientPaint?.w}×${h2.json.clientPaint?.h}，${h2.json.clientPaint?.panels} 个面板）`)
  // 出错时也要记下来
  await A.callRoute('/api/sci-viz/client-report', 'POST', '127.0.0.1', {
    tab: 'chart', open: true, w: 0, h: 0, kind: 'chart', panels: 3, err: 'boom @ paintChart',
  })
  const h3 = await A.callRoute('/api/sci-viz/health')
  ok(/boom/.test(h3.json.clientPaint?.err ?? ''), `绘制异常被记录：${h3.json.clientPaint?.err}`)
}

// ===========================================================================
console.log('\n== 结构工具（真实 AlphaFold PDB）==')
if (hasFixture('AF_O53740.pdb')) {
  const { value, def } = await A.run('sci_viz_structure', {
    source: fixture('AF_O53740.pdb'),
    label: '测试结构',
    highlight: ['S315T', '12', 'A:30'],
    style: 'cartoon',
  })
  const bad = validateValue(def.output.schema, value)
  ok(bad.length === 0, '返回值符合 output.schema', bad.slice(0, 3).join('；'))
  ok(value.atoms > 100, `解析到 ${value.atoms} 个原子`)
  ok(value.highlighted.length === 2, `高亮了 ${value.highlighted.join('/')}（S315T 不存在，已如实报告）`)
  ok(value.warnings.length === 1, `警告：${value.warnings[0]}`)
  console.log(`       ${value.summary.slice(0, 140)}`)
} else {
  skip('结构工具解析真实 PDB（4 项）',
    `缺 ${FIXTURES}/AF_O53740.pdb —— 设 SCIVIZ_FIXTURES=<目录> 可跑满`)
}

console.log('\n== 参数校验（故意写错）==')
{
  let threw = null
  try {
    await A.tools.get('sci_viz_structure').execute({ source: 123, bogus: true }, {})
  } catch (e) {
    threw = e.message
  }
  ok(threw !== null, '非法参数被拦下', threw ?? '')
}

// ===========================================================================
console.log('\n== 统计工具：9 种 kind ==')
const G = {
  a: [8.2, 7.9, 8.5, 8.1, 7.7, 8.8, 8.3, 8.0],
  b: [7.1, 6.8, 7.4, 7.0, 6.6, 7.5, 7.2, 6.9],
  c: [6.2, 6.0, 6.5, 5.9, 6.4, 6.1, 6.3, 6.0],
}
const statCases = [
  ['normal', { kind: 'normal', values: [...G.a, ...G.b], mu: 8, sigma: 0.6 }],
  ['ttest-welch', { kind: 'ttest', groups: [{ label: '野生型', values: G.a }, { label: '突变株', values: G.b }] }],
  ['ttest-paired', { kind: 'ttest', paired: true, groups: [{ label: '用药前', values: G.a }, { label: '用药后', values: G.b }] }],
  ['ttest-one', { kind: 'ttest', values: G.a, mu: 8 }],
  ['anova', { kind: 'anova', groups: [{ label: 'A', values: G.a }, { label: 'B', values: G.b }, { label: 'C', values: G.c }] }],
  ['chisq', { kind: 'chisq', table: [[18, 7], [6, 19]], rowLabels: ['敏感', '耐药'], colLabels: ['处理', '对照'] }],
  ['regression', { kind: 'regression', x: G.a.map((_, i) => i), y: G.a }],
  ['power', { kind: 'power', d: 0.5, power: 0.8 }],
  ['descriptives', { kind: 'descriptives', values: G.a }],
]
for (const [label, args] of statCases) {
  try {
    const { value, def } = await A.run('sci_viz_stats', args)
    const bad = validateValue(def.output.schema, value)
    ok(bad.length === 0 && value.ok, `${label}`, bad.slice(0, 2).join('；'))
  } catch (e) {
    ok(false, `${label} 抛错`, e.message)
  }
}

console.log('\n== 绘图 escape hatch 与技能工具 ==')
{
  const plot = await A.run('sci_viz_plot', {
    title: '自定义曲线',
    panels: [{ kind: 'xy', title: '一条线', layers: [{ type: 'line', pts: [[0, 0], [1, 1], [2, 4]] }] }],
  })
  ok(validateValue(plot.def.output.schema, plot.value).length === 0 && plot.value.ok, 'sci_viz_plot 正常')

  const hit = await A.run('sci_viz_skills', { query: 'pymol', limit: 5 })
  ok(hit.value.matched > 0, `sci_viz_skills 匹配 ${hit.value.matched} 个`)
  ok(hit.value.top[0].zh.length > 0, `中文说明来自快照：${hit.value.top[0].zh}`)
}

// ===========================================================================
console.log('\n== 路由 ==')
{
  const state1 = await A.callRoute('/api/sci-viz/state')
  ok(state1.status === 200 && state1.json.doc, 'GET /state 返回当前文档', `kind=${state1.json.doc?.kind}`)
  const same = await A.callRoute(`/api/sci-viz/state?rev=${state1.json.rev}`)
  ok(same.json.changed === false, '同 rev 时 changed=false')

  const cleared = await A.callRoute('/api/sci-viz/clear', 'POST')
  ok(cleared.json.ok, 'POST /clear 成功')
  const after = await A.callRoute('/api/sci-viz/state')
  ok(after.json.doc.kind === 'empty', '清空后为空态')

  const h1 = await A.callRoute('/api/sci-viz/health')
  ok(h1.json.ok && h1.json.clientSeenAt === 0 && h1.json.clientAlive === false, '/health 初始为「客户端未报到」')
  ok(h1.json.skills && h1.json.skills.total === 195, `/health 报告技能数 ${h1.json.skills?.total}`)
  await A.callRoute('/api/sci-viz/hello?v=smoke')
  const h2 = await A.callRoute('/api/sci-viz/health')
  ok(h2.json.clientAlive === true && h2.json.clientHits === 1, '报到后 clientAlive=true')
  ok(h2.json.config.portable === true, '/health 报告便携模式')

  const r403 = await A.callRoute('/api/sci-viz/state', 'GET', '10.0.0.5')
  ok(r403.status === 403, '非本机地址被拒（403）')
  const r403b = await A.callRoute('/api/sci-viz/hello', 'GET', '10.0.0.5')
  ok(r403b.status === 403, '/hello 同样拒绝非本机地址')
}

console.log('\n== 状态文件 ==')
{
  const text = readFileSync(join(sandbox, 'state-a', 'current.json'), 'utf8')
  ok(text.length > 10, `state/current.json ${text.length} 字节`)
  ok(JSON.parse(text).doc.kind === 'empty', '文件内容与最后状态一致')
}

// ---- 独立窗口地址（放最后：它会给 /hello 记一次「客户端报到」，不能污染前面的 health 断言）----
  // /hello 必须给出**真实 HTTP 地址**：桌面版渲染进程在 dsh-app:// 协议下，
  // 用 location 拼出来的地址浏览器打不开（用户实测：粘到搜索引擎里去了）。两条来源都要对。
  {
    const helloRoute = A.routes.get('exact:/api/sci-viz/hello')
    const callHello = async (req) => {
      let out = ''
      await helloRoute.handler(req, { writeHead() {}, end(p) { out = String(p) } })
      return JSON.parse(out)
    }
    const saved = process.env.DSH_WEB_URL
    process.env.DSH_WEB_URL = 'http://127.0.0.1:19387'
    const byEnv = await callHello({ url: '/api/sci-viz/hello', method: 'GET', socket: { remoteAddress: '127.0.0.1' } })
    ok(byEnv.viewer === 'http://127.0.0.1:19387/api/sci-viz/viewer',
      `/hello 用 DSH_WEB_URL 给出真地址：${byEnv.viewer}`)
    delete process.env.DSH_WEB_URL
    const byHost = await callHello({
      url: '/api/sci-viz/hello', method: 'GET',
      socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:19387' },
    })
    ok(byHost.viewer === 'http://127.0.0.1:19387/api/sci-viz/viewer',
      `没有环境变量时退回 Host 头：${byHost.viewer}`)
    ok(!String(byEnv.viewer).includes('dsh-app'), '地址不是 dsh-app:// 自定义协议（那个浏览器打不开）')
    if (saved !== undefined) process.env.DSH_WEB_URL = saved
  }

if (skipped.length) {
  console.log(`\n跳过 ${skipped.length} 段依赖本机数据的检查：`)
  for (const s of skipped) console.log(`  - ${s.label}（${s.why}）`)
}
console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures ? 1 : 0)
