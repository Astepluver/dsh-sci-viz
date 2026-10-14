/** 客户端入口自检：确认「能打开 / 能退出」这条链上的每一环都在。 */
import { readFileSync } from 'node:fs'

// 从脚本自身的位置推导插件目录：写死绝对路径会让这个脚本换个目录就跑不了，
// 而且会把开发机的用户名带进源码（参赛附件里必须去掉）。
const ROOT = new URL('..', import.meta.url)
const s = readFileSync(new URL('lib/client.js', ROOT), 'utf8')
const checks = [
  ['常驻入口 createLauncher', /function createLauncher\(onOpen\)/],
  ['药丸挂到 body', /document\.body\.appendChild\(launcher\.el\)/],
  ['入口点击 → 打开面板（已是本页则切回对话）', /selectPanel\(active === PANEL_ID \? null : PANEL_ID\)/],
  ['浮窗不带自己的药丸', /withLauncher: false/],
  ['主面板「返回对话」按钮', /data-act="back"/],
  ['返回 = selectPanel(null)', /selectPanel\(null\)/],
  ['Esc 也能返回', /e\.key === 'Escape'/],
  ['自动跳转开关', /autojumpRef\.current/],
  ['有新内容给药丸点灯', /pillRef\.current\.notify\(\)/],
  ['侧栏图标用 size/active', /const size = \(props && props\.size\)/],
  ['主面板铺满（embedded）', /sciviz-win-embedded/],
  ['浮窗是退路', /createPanel\(\{ embedded: false/],
  ['主面板槽位注册', /slots\.inject\('main'/],
  ['侧栏槽位注册', /slots\.inject\('sidebar\.panellist'/],
  ['watcher 槽位注册', /slots\.inject\('shell\.overlay'/],
  ['输入框入口槽位注册', /slots\.inject\('conversation\.input\.left'/],
  ['输入框按钮组件', /function ComposerButton\(\)/],
  // 「即用」链路：面板自己就能打开结构和跑统计
  ['结构页「打开」条', /data-pane="openbar"/],
  ['图表页「数据 + 运行」条', /data-pane="statsbar"/],
  ['拖放 .pdb/.cif 打开', /addEventListener\('drop'/],
  ['粘贴数据解析器', /function parseDataTable\(text, kind\)/],
  ['打开结构 → 宿主路由', /postJson\(`\$\{API\}\/open-structure`/],
  ['运行统计 → 宿主路由', /postJson\(`\$\{API\}\/run-stats`/],
  ['宿主是旧版时给出可读提示', /重启 DSH 后可用/],
  ['本地动作对齐版本号（避免重复投递）', /function adoptLocalDoc\(data\)/],
  // 技能库：随插件分发、按来源标注
  ['技能库说明写明随插件分发', /随插件一起分发/],
  ['来源芯片（自带 / 本地）', /插件自带 \$\{bundled\}/],
  // 「做完统计自动拉面板」+ 分步上报（面板空白时唯一线索）
  ['watcher 认 autoOpen 主动翻页', /data\.doc\.autoOpen \|\| autojumpRef\.current/],
  ['先入 store 再翻页（打开就有图）', /vizStore\.set\(data\.rev, data\.doc\)/],
  ['挂载分步上报', /function report\(phase, err\)/],
  ['失败时带步骤号上报', /apply-error@\$\{step\}/],
  ['挂载成功也上报', /report\('apply-ok'\)/],
  // 画布高度保护：面板矮的时候不能让图表面板被静默跳过
  ['图表有最小高度计算', /function chartMinHeight\(doc, width\)/],
  ['画布按最小高度撑高', /canvasH = Math\.max\(boxH, needH\)/],
  ['跳过面板会被计数上报', /if \(res && res\.skipped\) diag\.skipped = res\.skipped/],
  ['技能库不再有搜索框', /搜索框按用户要求去掉/],
]

/**
 * CSS 陷阱单独守一条：给面板设了 display 的类，必须同时写 [hidden]{display:none}，
 * 否则 JS 里的 `el.hidden = true` 会被类选择器压过。踩过两次 ——
 * 技能库面板挤掉半个画布、浮窗关不掉。
 */
{
  const css = s.slice(s.indexOf('const CSS'), s.indexOf('function installStyles'))
  for (const cls of ['canvasbox', 'skills', 'bar', 'win', 'launcher', 'root-embedded']) {
    const setsDisplay = new RegExp(`\\.sciviz-${cls}\\s*\\{[^}]*display\\s*:`).test(css)
    if (!setsDisplay) continue // 没设 display 的靠 UA 的 [hidden] 就够
    checks.push([`.sciviz-${cls} 设了 display，必须有 [hidden] 兜底`, new RegExp(`\\.sciviz-${cls}\\[hidden\\]`)])
  }
}

let bad = 0
for (const [name, re] of checks) {
  const hit = re.test(s)
  if (!hit) bad += 1
  console.log(`${hit ? '  ok  ' : ' FAIL '} ${name}`)
}
console.log(bad ? `${bad} 项缺失` : '入口与出口链路完整')
process.exit(bad ? 1 : 0)
