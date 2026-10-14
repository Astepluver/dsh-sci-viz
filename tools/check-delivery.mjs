/** 交付约束自检：零 npm 依赖、零构建步骤、体积规模。 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const P = join(dirname(fileURLToPath(import.meta.url)), '..')
let bad = 0
const chk = (cond, label, detail = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) bad += 1
}

// ---- 1. package.json 不得有运行时依赖 ---------------------------------------
const pkg = JSON.parse(readFileSync(join(P, 'package.json'), 'utf8'))
chk(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0,
  'package.json 没有 dependencies',
  pkg.dependencies ? Object.keys(pkg.dependencies).join(', ') : '（无）')
chk(!pkg.devDependencies || Object.keys(pkg.devDependencies).length === 0, 'package.json 没有 devDependencies')
chk(pkg.dsh?.client?.inject?.length === 0, 'dsh.client.inject 为空（不额外请求模块）')
chk(pkg.dsh?.bundle?.patch === './cordis.patch.yml', '声明了 bundle patch')

// ---- 2. 源码只允许 node: 内置模块 + react（平台种子表） ---------------------
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])

const libFiles = walk(join(P, 'lib')).filter((f) => f.endsWith('.js'))
const importRe = /(?:^|\n)\s*import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g
const requireRe = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g
const bare = []
for (const f of libFiles) {
  const src = readFileSync(f, 'utf8')
  for (const re of [importRe, requireRe]) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(src)) !== null) {
      const spec = m[1]
      if (spec.startsWith('.') || spec.startsWith('node:')) continue
      if (spec === 'react') continue // 平台种子表里的静态模块
      bare.push(`${f.replace(P, '')}: ${spec}`)
    }
  }
}
chk(bare.length === 0, `lib/ 里没有第三方 bare import（${libFiles.length} 个文件）`, bare.join('; '))
chk(!existsSync(join(P, 'node_modules')), '插件目录里没有 node_modules（不复制依赖）')

// ---- 3. 没有构建步骤 --------------------------------------------------------
const buildMarkers = ['tsdown.config', 'rollup.config', 'vite.config', 'webpack.config', 'esbuild.config', 'tsconfig.json', '.babelrc']
chk(!buildMarkers.some((m) => existsSync(join(P, m))), '没有打包/编译配置')
chk(!pkg.scripts || Object.keys(pkg.scripts).length === 0, 'package.json 没有 build 脚本',
  pkg.scripts ? Object.keys(pkg.scripts).join(', ') : '（无）')
chk(pkg.main === 'lib/index.js' && pkg.exports['./client'] === './lib/client.js',
  'main / exports["./client"] 直接指向手写文件（没有中间产物）')

// ---- 4. 体积 ---------------------------------------------------------------
const RUNTIME = ['lib/index.js', 'lib/client.js', 'lib/core/numeric.js', 'lib/core/structure.js',
  'lib/verify-protocol.js', 'data/taxonomy.json', 'data/skill-pack.json.gz']
const sum = (files) => files.reduce((a, f) => a + statSync(join(P, f)).size, 0)
const runtimeKB = sum(RUNTIME) / 1024
chk(runtimeKB < 1536, `运行时文件合计 ${runtimeKB.toFixed(0)} KB（技能正文 2.3 MB 压到 0.85 MB 后的规模）`)
const total = walk(P).filter((f) => !f.includes('\\state\\')).reduce((a, f) => a + statSync(f).size, 0) / 1024
console.log(`        运行时明细：${RUNTIME.map((f) => `${f.split(/[\\/]/).pop()} ${(statSync(join(P, f)).size / 1024).toFixed(0)}KB`).join(' / ')}`)
console.log(`        含验证脚本 ${total.toFixed(0)} KB；state/current.json 另行占用（只有一个文件、每次覆盖）`)

// ---- 4b. 分发件里不许留占位符 / 别人机器的路径 --------------------------------
// 为什么必须查：
//   · DSH 对 bundle patch **不做占位符替换**，残留的 "<插件目录>" 会被当成真字符串
//     覆盖 lib/index.js 的默认值（浅合并），stateDir 就变成相对当前目录的路径；
//   · 技能包是 gzip 二进制，普通 grep 与 `git grep -I` 都会跳过它 —— 路径就是这么漏过两次的。
{
  const patchText = readFileSync(join(P, 'cordis.patch.yml'), 'utf8')
  const patchBody = patchText.split(/\r?\n/).filter((l) => !l.trim().startsWith('#')).join('\n')
  const placeholders = patchBody.match(/<[^>\n]{2,}>/g) ?? []
  chk(placeholders.length === 0,
    'cordis.patch.yml 没有 <…> 占位符（DSH 不替换占位符，会覆盖默认值）',
    placeholders.join(' '))

  const packPath = join(P, 'data', 'skill-pack.json.gz')
  if (pkg.private === true) {
    console.log('        开发副本（private: true）：技能包里的本机路径留在本地，跳过「路径已抹除」检查')
  } else if (existsSync(packPath)) {
    const { gunzipSync } = await import('node:zlib')
    const text = gunzipSync(readFileSync(packPath)).toString('utf8')
    const home = text.match(/[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+/g) ?? []
    chk(home.length === 0, `技能包里没有本机用户目录（${home.slice(0, 3).join(' / ') || '干净'}）`)
  }
}

// ---- 5. 「分享出去就能用」：技能必须随包分发 --------------------------------
// 这是插件最重要的对外承诺，单独钉住：包在、包里有正文、包被声明为要分发的文件。
{
  const packPath = join(P, 'data', 'skill-pack.json.gz')
  chk(existsSync(packPath), '技能包 data/skill-pack.json.gz 存在（对方无需本地技能目录）')

  if (existsSync(packPath)) {
    const { gunzipSync } = await import('node:zlib')
    let pack = null
    try {
      pack = JSON.parse(gunzipSync(readFileSync(packPath)).toString('utf8'))
    } catch (e) {
      chk(false, '技能包可解压解析', e.message)
    }
    if (pack) {
      const skills = pack.skills ?? []
      chk(skills.length >= 190, `包里 ${skills.length} 个技能`)
      const noBody = skills.filter((s) => !s.content || s.content.length < 50)
      chk(noBody.length === 0, `每个技能都带完整正文（缺正文 ${noBody.length} 个）`)
      const badName = skills.filter((s) => !/^[a-z0-9][a-z0-9-]*$/.test(s.name))
      chk(badName.length === 0, `技能名都是 kebab-case（不合规 ${badName.length} 个）`,
        badName.slice(0, 3).map((s) => s.name).join(', '))
      const noDesc = skills.filter((s) => !s.description)
      chk(noDesc.length === 0, `每个技能都有 description（缺 ${noDesc.length} 个）`)
      const dupes = skills.length - new Set(skills.map((s) => s.name)).size
      chk(dupes === 0, `包内没有重名（重复 ${dupes} 个）`)
      chk((pack.categories ?? []).length > 0, `分类表也在包里（${(pack.categories ?? []).length} 类）`)
    }
    // 宿主必须真的读它、注册它
    const host = readFileSync(join(P, 'lib', 'index.js'), 'utf8')
    chk(/skillPackPath/.test(host), '宿主读 skillPackPath')
    chk(/ctx\.get\('skills'\)/.test(host) && /skills\.register\(/.test(host), '宿主把技能注册进 ctx.skills')
    chk(/\? 'bundled' : 'custom'/.test(host), "注册时自带技能标注 source: 'bundled'")
    chk(/probeSkillRegistry/.test(host), '/health 会向技能系统自查注册结果（可自证）')
  }
  // 分发包里必须带上 data/
  const files = pkg.files ?? []
  chk(files.some((f) => f === 'data' || f.startsWith('data/')), `package.json files 含 data/（当前：${files.join(', ')}）`)
}

console.log(bad ? `\n${bad} 项不满足` : '\n交付约束全部满足')
process.exit(bad ? 1 : 0)
