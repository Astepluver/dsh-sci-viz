/**
 * 验证规程自检：`node tools/check-verify-protocol.mjs`
 *
 * 为什么这个检查必须存在：验证规程是「插件自带的保险」，它的失败模式是**静默失效**
 * （段落不注入、守卫不生效，而没有任何报错）。所以把它钉成断言：段落按身份分发对不对、
 * 守卫在该拦的地方拦、该放的地方放、队友有没有被误伤、缺服务时会不会降级。
 *
 * 零依赖、不联网、不碰状态文件；换台机器直接能跑。
 */
import { strict as assert } from 'node:assert'

import {
  SECTION_NAME,
  VERIFY_DEFAULTS,
  applyVerifyProtocol,
  buildVerifyPolicy,
  buildVerifyThreadNote,
  normalizeVerifyConfig,
  scratchVerdict,
  verifyGuardDecision,
  verifySectionText,
} from '../lib/verify-protocol.js'

let bad = 0
const ok = (cond, label, detail = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) bad += 1
}

const PATHS = { pluginDir: 'C:\\somewhere\\dsh-sci-viz', stateDir: 'C:\\somewhere\\dsh-sci-viz\\state' }
const leadAgent = { session: { header: {} } }
const subAgent = { session: { header: { origin: 'subagent', cwd: 'C:\\work' } } }
const teamAgent = { session: { header: { origin: 'subagent', cwd: 'C:\\work' } } }

/** 假 ctx：可控地提供/不提供服务。 */
function fakeCtx(options = {}) {
  const sections = []
  const guards = []
  return {
    sections,
    guards,
    get(name) {
      if (name === 'systemPrompt') return options.noSystemPrompt ? undefined : { section: (s) => (sections.push(s), () => {}) }
      if (name === 'tools') {
        if (options.noTools) return undefined
        return options.noGuard ? {} : { guard: (g) => (guards.push(g), () => {}) }
      }
      if (name === 'agentTeams') return options.agentTeams
      return undefined
    },
  }
}

const exec = (name, filePath, opts = {}) => ({
  name,
  arguments: filePath === undefined ? {} : { file_path: filePath },
  // 注意：`opts.origin === undefined` 要表达的是「根会话」，所以不能用 ?? 兜底
  agent:
    opts.agent ??
    {
      session: {
        header: {
          origin: 'origin' in opts ? opts.origin : 'subagent',
          cwd: 'cwd' in opts ? opts.cwd : 'C:\\work',
        },
      },
    },
})

// ---- 1. 配置归一化 ---------------------------------------------------------
const d = normalizeVerifyConfig(undefined)
ok(d.enabled === VERIFY_DEFAULTS.enabled && d.verifyScratchDir === '.dsh-verify' && d.deniedTools.join() === 'write,edit',
  '空配置等于默认值')
const badCfg = normalizeVerifyConfig({ enabled: 'yes', sectionOrder: NaN, verifyScratchDir: 7, deniedTools: [], allowScratchWrites: 'no' })
ok(badCfg.enabled === true && badCfg.sectionOrder === VERIFY_DEFAULTS.sectionOrder && badCfg.verifyScratchDir === '.dsh-verify' &&
  badCfg.deniedTools.join() === 'write,edit' && badCfg.allowScratchWrites === true, '非法值退回默认，不抛异常')

// ---- 2. 段落文本（可分享性：不出现写死的用户名/盘符约定） --------------------
const policy = buildVerifyPolicy({ pluginDir: PATHS.pluginDir, stateDir: PATHS.stateDir, scratchDir: '.dsh-verify' })
ok(policy.includes('科研可视化验证规程'), '规程有标题')
for (const key of ['第 0 层', '第 1 层', '第 2 层', '第 3 层', 'recompute.py --selftest', '不得调用 sci_viz_* 工具', '.dsh-verify', '已对拍', '待人工确认']) {
  ok(policy.includes(key), `规程含「${key}」`)
}
ok(policy.includes(PATHS.pluginDir.replace(/\\/g, '/')), '规程里的路径来自运行期（可迁移）')
ok(!/C:\\Users\\/.test(policy), '规程里没有写死任何用户目录')

// ---- 3. 身份分发 -----------------------------------------------------------
const verify = normalizeVerifyConfig(undefined)
ok(verifySectionText(fakeCtx(), verify, { agent: leadAgent }, PATHS).includes('科研可视化验证规程'), '根会话拿到完整规程')
const threadText = verifySectionText(fakeCtx(), verify, { agent: subAgent }, PATHS)
ok(threadText.includes('线索模式 · sci-viz 专项') && !threadText.includes('第 0 层'), '子代理拿到短指令而不是整篇规程')
const teamCtx = fakeCtx({ agentTeams: { tryMembership: (a) => (a === teamAgent ? { role: 'teammate' } : undefined) } })
ok(verifySectionText(teamCtx, verify, { agent: teamAgent }, PATHS) === '', 'Agent Teams 队友不被注入（不误伤）')
ok(verifySectionText(fakeCtx(), normalizeVerifyConfig({ enabled: false }), { agent: leadAgent }, PATHS) === '', '关掉后一段都不注入')

// ---- 4. 守卫：该拦的拦、该放的放 -------------------------------------------
const ctx = fakeCtx()
ok(verifyGuardDecision(ctx, exec('write', 'C:\\work\\.dsh-verify\\a.py'), verify) === undefined, 'scratch 内的写在 guard 层放行')
ok(verifyGuardDecision(ctx, exec('write', 'C:\\work\\src\\a.py'), verify).includes('越出 scratch'), 'scratch 外的写被拒且带原因')
ok(verifyGuardDecision(ctx, exec('write', 'C:\\work\\.dsh-verify\\..\\x.py'), verify).includes('..'), '`..` 越界被拒')
ok(verifyGuardDecision(ctx, exec('write', 'C:\\work\\src\\a.py', { origin: undefined }), verify) === undefined, '根会话一律放行')
ok(verifyGuardDecision(ctx, exec('read', 'C:\\work\\src\\a.py'), verify) === undefined, '读工具不受影响')
ok(verifyGuardDecision(teamCtx, exec('write', 'C:\\work\\src\\a.py', { agent: teamAgent }), verify) === undefined, '队友写盘不被拦（不破坏 Team）')
ok(verifyGuardDecision(ctx, exec('pwsh', undefined), verify) === undefined, '默认不拦 shell（拦了验证会变弱）')
ok(verifyGuardDecision(ctx, exec('pwsh', undefined), normalizeVerifyConfig({ denyShell: true })) !== undefined, 'denyShell=true 时 shell 被拦')
ok(verifyGuardDecision(ctx, exec('write', 'C:\\work\\src\\a.py'), normalizeVerifyConfig({ subagentReadOnly: false })) === undefined, '守卫可整体关掉')

// ---- 5. 降级与漏配 ---------------------------------------------------------
const noSvc = fakeCtx({ noSystemPrompt: true, noTools: true })
ok(applyVerifyProtocol(noSvc, undefined, PATHS) instanceof Function, '缺 systemPrompt/tools 时不抛异常（静默降级）')
const noGuard = fakeCtx({ noGuard: true })
applyVerifyProtocol(noGuard, undefined, PATHS)
ok(noGuard.sections.length === 1 && noGuard.guards.length === 0, 'tools 服务没有 guard 时只装段落')
const wired = fakeCtx()
applyVerifyProtocol(wired, undefined, PATHS)
ok(wired.sections.length === 1 && wired.sections[0].name === SECTION_NAME && wired.guards.length === 1, '两个服务都在时段落 + 守卫都装')
ok(wired.sections[0].order === VERIFY_DEFAULTS.sectionOrder, '段落排序取配置值')
ok(applyVerifyProtocol(fakeCtx(), { enabled: false }, PATHS) instanceof Function, 'enabled=false 时直接返回空 disposer')

// ---- 6. 降级判定（没有 cwd 时） --------------------------------------------
ok(scratchVerdict(exec('write', '.dsh-verify/a.py', { cwd: undefined }), verify).allowed === true, '没有 cwd 时降级按目录名放行')
ok(scratchVerdict(exec('write', 'C:\\other\\a.py', { cwd: undefined }), verify).allowed === false, '没有 cwd 且不含 scratch 段时拒绝')

console.log(bad === 0 ? '\n验证规程自检：全部通过' : `\n验证规程自检：${bad} 条失败`)
process.exitCode = bad === 0 ? 0 : 1
