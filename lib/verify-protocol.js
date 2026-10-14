/**
 * 科研可视化验证规程 —— 由 dsh-sci-viz 自己带的一段系统提示 + 一道子代理守卫。
 *
 * 为什么长在插件里，而不是另一个插件来探测：
 *   1. 这个插件是**要分享出去**的（装上就能用）。保险跟着插件走，对方才拿得到；
 *      靠"另一个插件运行时探测 sci-viz 在不在"的方案，探测一失败保险就静默失效。
 *   2. sci-viz 自己当然知道自己在跑：不需要任何探测，注册即生效。
 *
 * 可分享性约束（照插件本体的交付口径）：
 *   · 只 import `node:` 内置模块，零第三方依赖、零构建；
 *   · **不硬编码任何本机路径** —— 需要用到的路径（插件目录、stateDir）都在运行期算出来，
 *     换台机器自动就是对方的路径；
 *   · 服务拿不到（别人的组合里没有 systemPrompt/tools）就静默降级，绝不拖垮挂载。
 *
 * @module dsh-sci-viz/lib/verify-protocol
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'

/** 段落名（同一层内唯一）。 */
export const SECTION_NAME = 'sci-viz:verify-protocol'

/** 默认配置；可在 profile 的 cordis.patch.yml 里用 `verifyProtocol` 覆盖。 */
export const VERIFY_DEFAULTS = Object.freeze({
  /** 总开关。 */
  enabled: true,
  /** 段落排序：落在 PLAN_POLICY(500) / TEAM_POLICY(600) 之后，PTC_ONLY(800) 之前。 */
  sectionOrder: 750,
  /** 验证子代理唯一可写的目录（相对会话 cwd，天然可迁移）。 */
  verifyScratchDir: '.dsh-verify',
  /** 是否给子代理加只读守卫。 */
  subagentReadOnly: true,
  /** 是否开放验证通道（false = 子代理完全只读）。 */
  allowScratchWrites: true,
  /** 被拦的工具名。 */
  deniedTools: Object.freeze(['write', 'edit']),
  /**
   * 是否连 shell 一起拦。默认 false：拦了 shell，验证子代理就跑不了对拍脚本，
   * 验证能力反而变弱。注意这条守卫**本来就不是安全边界**（shell 可写任意路径）。
   */
  denyShell: false,
})

const SHELL_TOOLS = ['pwsh', 'bash']

const isText = (value) => typeof value === 'string' && value.length > 0

/**
 * 归一化配置：非法值退回默认，绝不抛异常（挂载期抛异常会拖垮整个 bundle）。
 * @param raw - cordis.patch.yml 里的 `verifyProtocol`。
 * @returns 完整配置。
 */
export function normalizeVerifyConfig(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const bool = (key) => (typeof input[key] === 'boolean' ? input[key] : VERIFY_DEFAULTS[key])
  const denied = Array.isArray(input.deniedTools) ? input.deniedTools.filter(isText) : []
  return {
    enabled: bool('enabled'),
    sectionOrder: Number.isFinite(input.sectionOrder) ? input.sectionOrder : VERIFY_DEFAULTS.sectionOrder,
    verifyScratchDir: isText(input.verifyScratchDir) ? input.verifyScratchDir : VERIFY_DEFAULTS.verifyScratchDir,
    subagentReadOnly: bool('subagentReadOnly'),
    allowScratchWrites: bool('allowScratchWrites'),
    deniedTools: denied.length > 0 ? denied : [...VERIFY_DEFAULTS.deniedTools],
    denyShell: bool('denyShell'),
  }
}

/** 把路径里的反斜杠统一成 `/`，便于在提示词里跨平台显示。 */
const nicePath = (p) => String(p).replace(/\\/g, '/')

/**
 * 渲染给**根会话**的完整规程。
 * @param options - `{ pluginDir, stateDir, scratchDir }`，全部在运行期算出（可迁移）。
 * @returns 段落文本。
 */
export function buildVerifyPolicy(options) {
  const { pluginDir, stateDir, scratchDir } = options
  const tools = nicePath(pluginDir) + '/tools'
  return [
    '科研可视化验证规程（dsh-sci-viz 自带）',
    `sci-viz 的结构：5 个工具（sci_viz_structure / stats / plot / genomics / skills）只写「唯一真源」状态文件（当前 stateDir：${nicePath(stateDir)}/current.json），浏览器半边每 1.5 秒轮询它渲染面板。所以「图对不对」必须分层说，任何一层都不能冒充另一层。`,
    '',
    '第 0 层·通道自检（先说清哪些通道在这台机器上真的能跑）',
    '- 先探测再声明：缺依赖的通道**如实标「不可用」**，不要声称已跑过。',
    `- 数值对拍：${tools}/verify-math.py 对拍 scipy，需要带 scipy 的解释器；没有 scipy 就改用本插件自带的 ${tools}/recompute.py（纯标准库，不依赖 scipy）。`,
    `- 几何通道：${tools}/verify-visual.mjs 需要 node + 可解析的 sharp + 工作区里的 PDB fixture；缺任何一项就标不可用。`,
    '- 产物新鲜度：**脚本跑过才算证据**。产物不存在、或早于被测源码的修改时间，等于没验过；要留证据就带 --keep 跑，并把产物路径写进交付。',
    '',
    '第 1 层·契约层（纯读，零副作用）—— 必做',
    '- 核对 doc.kind 与 panels[].kind 是否与要求一致；标题/副标题是否写清**数据来源与日期**；样本量 n、分组、缺失值处理是否标注；图上每个数字能否追到输入数据或工具返回 —— 追不到就标「无来源」。',
    '- 状态文档**没有 JSON Schema 校验器**：字段存在只能证明结构，证明不了语义。不要用"schema 通过"代替数值与视觉核对。',
    '',
    '第 2 层·数值对拍（独立实现重算）—— 关键统计量必做',
    `- 先证明 oracle 自身可信：\`python ${tools}/recompute.py --selftest\`（10 项已发表临界值全部命中才允许使用）。`,
    '- 再对拍：把同一份输入喂给 recompute.py，与图上数字比对 t / ANOVA / 卡方 / 回归 / 描述统计，容差 rtol≈1e-6；不一致就报「两份数字 + 差值」，**不要私自改数**。',
    '- 也可以跑 verify-math（覆盖 JS 数值内核），但它只覆盖 lib/core/numeric.js，不覆盖状态、渲染与工具契约。',
    '',
    '第 3 层·几何与视觉（机器验几何，人看语义）',
    '- verify-visual.mjs 只有数量与几何量断言（图元数、rect/path 比例、SVG 标签配平、旋转矩阵、chartMinHeight、focus 缩放比），**没有任何像素基线比对**；它能光栅成 PNG 供 AI 用 read_image 看。',
    '- 但 measureText 是按字宽估算的（CJK 1.0em / 其余 0.55em），所以**标签遮挡、截断、配色语义、数据→几何映射是否正确，机器判不了**；volcano 用例用 Math.random 造输入，**不可复现**，不能当回归基线。',
    '- 因此这一层必须交回用户：交付时列一份**人工确认清单**（逐条写清该看什么），并声明「未自动验证」。',
    '',
    '工具调度纪律（最容易出事的一条）',
    '- 验证子代理**不得调用 sci_viz_* 工具**：5 个工具都会覆盖唯一真源，把用户正在看的面板冲掉（skills 工具还会把面板切走）。',
    `- 要重跑就由 Lead 在明确告知用户后执行，或用同一份输入离线重算；免副作用的重跑路径是显式传临时 stateDir（那是宿主配置，不是模型能改的）。`,
    `- 验证子代理只能在 \`<会话 cwd>/${scratchDir}/\` 内写文件（插件守卫只对这条路径放行），其余路径照旧拒绝；源数据只读。`,
    '',
    '交付声明（三档，不许混用）',
    '  ① 已对拍 = 列出对拍项、容差、oracle 自检结果；② 仅契约校验 = 明确写「未做数值对拍」；③ 待人工确认 = 视觉层，列出人工清单。把没验的写成已验，是本规程里最严重的错误。',
  ].join('\n')
}

/**
 * 渲染给**线索子代理**的短指令。
 * @param options - `{ scratchDir }`。
 * @returns 段落文本。
 */
export function buildVerifyThreadNote(options) {
  return [
    '线索模式 · sci-viz 专项',
    '- 只读核对状态文件与工具返回；**不要调用 sci_viz_* 工具**（会覆盖用户正在看的唯一真源）。',
    `- 需要算数才能验证时：写在 \`<会话 cwd>/${options.scratchDir}/\` 内的临时文件是被允许的（其它路径会被守卫拒绝）；先跑 recompute.py --selftest 证明 oracle 可信，再拿它做独立重算。`,
    '- 视觉层你验不了：只回报「需要在界面上确认什么」，不要写「已验证」。',
  ].join('\n')
}

/** 从 assemble 上下文里取 Agent（`scope` 就是 Agent 实例，公开类型只声明了 scope）。 */
export function agentOf(context) {
  if (context === null || typeof context !== 'object') return undefined
  if (context.agent !== null && context.agent !== undefined) return context.agent
  const scope = context.scope
  if (scope !== null && typeof scope === 'object' && 'session' in scope) return scope
  return undefined
}

/** 子会话身份：`origin` 只有 undefined（根）与 'subagent'（子代理/队友/workflow 子会话）。 */
export function isSubagentSession(agent) {
  return agent?.session?.header?.origin === 'subagent'
}

/**
 * Agent Teams 成员豁免（可选的 agentTeams 服务；取不到就当作非队友）。
 * 必要性：teammate 与一次性子代理共用 `origin === 'subagent'`，但队友按分工要真落盘，
 * 锁死会把 Team 功能弄坏。
 */
export function isTeamMember(ctx, agent) {
  if (agent === null || agent === undefined) return false
  if (typeof ctx?.get !== 'function') return false
  let service
  try {
    service = ctx.get('agentTeams')
  } catch {
    return false
  }
  if (service === null || service === undefined || typeof service.tryMembership !== 'function') return false
  try {
    return service.tryMembership(agent) !== undefined
  } catch {
    return false
  }
}

/**
 * 段落文本：根会话给完整规程，子代理给短指令，队友给空串（空文本会被 harness 丢弃）。
 * @param ctx - Cordis 上下文。
 * @param verify - 归一化后的配置。
 * @param context - AssembleContext。
 * @param paths - `{ pluginDir, stateDir }`。
 * @returns 段落文本。
 */
export function verifySectionText(ctx, verify, context, paths) {
  if (!verify.enabled) return ''
  const agent = agentOf(context)
  const thread = isSubagentSession(agent)
  if (thread && isTeamMember(ctx, agent)) return ''
  if (thread) return buildVerifyThreadNote({ scratchDir: verify.verifyScratchDir })
  return buildVerifyPolicy({
    pluginDir: paths.pluginDir,
    stateDir: paths.stateDir,
    scratchDir: verify.verifyScratchDir,
  })
}

/** 会话工作目录。 */
function execCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return isText(cwd) ? cwd : undefined
}

/** 从工具参数里取目标路径（不同工具/版本可能用不同键名）。 */
function targetPathOf(args) {
  if (args === null || typeof args !== 'object') return undefined
  for (const key of ['file_path', 'filePath', 'path', 'filename']) {
    if (isText(args[key])) return args[key]
  }
  return undefined
}

/** 路径里是否出现 `..` 段。 */
function hasTraversal(rawPath) {
  return rawPath.split(/[\\/]+/).some((segment) => segment === '..')
}

/** Windows 下路径大小写不敏感。 */
function comparable(path, win) {
  return win ? path.toLowerCase() : path
}

/**
 * 验证通道判定 + **拒绝理由**（理由要能指出卡在哪一环，否则没法排查）。
 * 主路径用「会话 cwd + 路径包含」精确判定；拿不到 cwd 时降级为按 scratch 目录名匹配
 * 并标明降级（这条守卫不是安全边界，降级可接受）。
 * @param exec - ToolExecution。
 * @param verify - 归一化后的配置。
 * @returns `{ allowed, reason }`。
 */
export function scratchVerdict(exec, verify) {
  if (!verify.enabled) return { allowed: false, reason: 'verifyProtocol.enabled=false' }
  if (!verify.allowScratchWrites) return { allowed: false, reason: 'verifyProtocol.allowScratchWrites=false' }
  const toolName = typeof exec?.name === 'string' ? exec.name : ''
  if (!verify.deniedTools.includes(toolName)) return { allowed: false, reason: `tool "${toolName}" 不在 deniedTools` }
  const rawPath = targetPathOf(exec?.arguments)
  if (rawPath === undefined) return { allowed: false, reason: '参数里没有可识别的目标路径' }
  if (hasTraversal(rawPath)) return { allowed: false, reason: `路径含 .. 段：${rawPath}` }
  const cwd = execCwd(exec)
  if (cwd === undefined) {
    const segment = verify.verifyScratchDir.replace(/^[\\/]+/, '').split(/[\\/]+/)[0]
    const hit = rawPath.split(/[\\/]+/).includes(segment)
    return hit
      ? { allowed: true, reason: `降级判定：会话没有 cwd，按目录名 ${segment} 匹配放行` }
      : { allowed: false, reason: `会话没有 cwd，且路径不含 ${segment} 段：${rawPath}` }
  }
  const win = process.platform === 'win32'
  const root = comparable(resolve(cwd, verify.verifyScratchDir), win)
  const target = comparable(isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath), win)
  const rel = relative(root, target)
  if (rel === '') return { allowed: false, reason: `目标是 scratch 目录本身：${rawPath}` }
  if (isAbsolute(rel)) return { allowed: false, reason: `不在同一盘符：${rawPath}` }
  if (rel === '..' || rel.startsWith(`..${sep}`)) return { allowed: false, reason: `越出 scratch：${rawPath}` }
  return { allowed: true, reason: `落在 ${root} 内` }
}

/**
 * 守卫：只拦「子代理会话 + 命中黑名单 + 不在 scratch 内」。
 * @param ctx - Cordis 上下文（用于队友豁免）。
 * @param exec - ToolExecution。
 * @param verify - 归一化后的配置。
 * @returns 拒绝理由字符串（返回字符串即拒绝）；放行返回 undefined。
 */
export function verifyGuardDecision(ctx, exec, verify) {
  if (!verify.subagentReadOnly) return undefined
  if (exec?.agent?.session?.header?.origin !== 'subagent') return undefined
  if (isTeamMember(ctx, exec?.agent)) return undefined
  const toolName = typeof exec?.name === 'string' ? exec.name : ''
  const denied = new Set(verify.deniedTools)
  if (verify.denyShell) for (const shell of SHELL_TOOLS) denied.add(shell)
  if (!denied.has(toolName)) return undefined
  const verdict = scratchVerdict(exec, verify)
  if (verdict.allowed) return undefined
  return [
    `sci-viz 验证守卫：子代理会话是「线索」，只查不做，工具 "${toolName}" 被拒绝，本次未执行。`,
    `请改为只读核对，并把结论整理成：证据（文件:行 / 命令输出）、结论、以及需要落盘时应做什么改动（标注「待纠正项」）。`,
    `【验证通道未放行的原因：${verdict.reason}】`,
  ].join(' ')
}

/**
 * 安装验证规程：注册段落 + 子代理守卫。缺服务就静默降级，返回空 disposer。
 * @param ctx - Cordis 上下文。
 * @param rawVerify - 原始配置（`config.verifyProtocol`）。
 * @param paths - `{ pluginDir, stateDir }`，运行期算出。
 * @returns 释放函数。
 */
export function applyVerifyProtocol(ctx, rawVerify, paths) {
  const verify = normalizeVerifyConfig(rawVerify)
  if (!verify.enabled) return () => {}
  const disposers = []
  const systemPrompt = ctx.get?.('systemPrompt')
  if (systemPrompt?.section) {
    disposers.push(
      systemPrompt.section({
        name: SECTION_NAME,
        order: verify.sectionOrder,
        text: (context) => verifySectionText(ctx, verify, context, paths),
      }),
    )
  }
  const tools = ctx.get?.('tools')
  if (tools?.guard && verify.subagentReadOnly) {
    disposers.push(tools.guard((exec) => verifyGuardDecision(ctx, exec, verify)))
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 释放失败不影响挂载事务 */
      }
    }
  }
}
