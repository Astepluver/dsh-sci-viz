/**
 * 打两个发布包：
 *   dist/dsh-sci-viz-<version>.tgz   ← **DSH 能直接装的那个**（npm 风格的 tarball）
 *   dist/dsh-sci-viz-<version>.zip   ← 给人看源码 / 手动解压后按本地目录安装
 *
 * 为什么必须有 .tgz：DSH 的插件安装框只认四种规格
 *   · npm 包名   · GitHub 仓库地址   · 本地绝对目录路径   · **.tgz / .tar.gz 直链**
 * （见 @deepseek-ai/dsh-plugin-manager 的 parseInstallSpec）。**zip 不在其中** ——
 * 只发 zip 的话，对方只能「先解压、再填本地目录」，多一步且容易卡在路径上。
 * 而 .tgz 直链可以直接贴进安装框，一步到位。
 *
 * tar 也是自己写的（ustar 头，约 50 行），理由同 ZIP：零依赖、路径与权限完全可控。
 * tarball 内部必须以 package/ 开头，这是 npm 的约定，pnpm 照着它解包。
 *
 * 不含 state/（运行期产物，每次覆盖，不该随包分发）。
 *
 * 用法：node tools/make-release.mjs [--out=目录]
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs'
import { deflateRawSync, gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { join, dirname, relative, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const P = join(HERE, '..')
const pkg = JSON.parse(readFileSync(join(P, 'package.json'), 'utf8'))
const NAME = pkg.name
const VERSION = pkg.version

const outArg = process.argv.slice(2).find((a) => a.startsWith('--out='))
const OUT_DIR = outArg ? outArg.slice(6) : join(P, 'dist')

// ---- 收集要打包的文件 -------------------------------------------------------
const INCLUDE_FILES = ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'CHANGELOG.md', 'THIRD-PARTY.md', '功能清单.md']
const INCLUDE_DIRS = ['lib', 'data', 'tools']
const EXCLUDE = [/^state\//, /\.tmp\//, /\/\.tmp\//, /node_modules\//, /\.zip$/, /_session-decoded/, /^dist\//]

const files = []
const add = (abs, rel) => {
  if (EXCLUDE.some((re) => re.test(rel))) return
  files.push({ abs, rel })
}
const walk = (abs, rel) => {
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const childAbs = join(abs, e.name)
    const childRel = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) walk(childAbs, childRel)
    else if (e.name.startsWith('_')) continue // 临时脚本
    else add(childAbs, childRel)
  }
}
for (const f of INCLUDE_FILES) {
  if (existsSync(join(P, f))) add(join(P, f), f)
}
for (const d of INCLUDE_DIRS) {
  if (existsSync(join(P, d))) walk(join(P, d), d)
}
files.sort((a, b) => (a.rel < b.rel ? -1 : 1))

// ---- 最小 ZIP 写入 ----------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/** DOS 时间戳（ZIP 用的是这个古老格式）。 */
function dosTime(d) {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xffff
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff
  return { time, date }
}

const now = new Date()
const { time: dosT, date: dosD } = dosTime(now)
const locals = []
const centrals = []
let offset = 0

for (const f of files) {
  const raw = readFileSync(f.abs)
  const deflated = deflateRawSync(raw, { level: 9 })
  // 已经压过的（.gz）再 deflate 只会更大，那就原样存
  const useDeflate = deflated.length < raw.length
  const body = useDeflate ? deflated : raw
  const method = useDeflate ? 8 : 0
  const name = Buffer.from(`${NAME}/${f.rel}`, 'utf8')
  const crc = crc32(raw)
  const { time, date } = dosTime(statSync(f.abs).mtime)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4) // version needed
  local.writeUInt16LE(0x0800, 6) // 文件名用 UTF-8
  local.writeUInt16LE(method, 8)
  local.writeUInt16LE(time, 10)
  local.writeUInt16LE(date, 12)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(body.length, 18)
  local.writeUInt32LE(raw.length, 22)
  local.writeUInt16LE(name.length, 26)
  local.writeUInt16LE(0, 28)
  locals.push(local, name, body)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4) // version made by
  central.writeUInt16LE(20, 6) // version needed
  central.writeUInt16LE(0x0800, 8)
  central.writeUInt16LE(method, 10)
  central.writeUInt16LE(time, 12)
  central.writeUInt16LE(date, 14)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(body.length, 20)
  central.writeUInt32LE(raw.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt16LE(0, 30) // extra
  central.writeUInt16LE(0, 32) // comment
  central.writeUInt16LE(0, 34) // disk
  central.writeUInt16LE(0, 36) // internal attrs
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38) // 权限：普通文件（>>> 0 避免 32 位有符号溢出）
  central.writeUInt32LE(offset, 42)
  centrals.push(central, name)

  offset += local.length + name.length + body.length
}

const centralBuf = Buffer.concat(centrals)
const eocd = Buffer.alloc(22)
eocd.writeUInt32LE(0x06054b50, 0)
eocd.writeUInt16LE(0, 4)
eocd.writeUInt16LE(0, 6)
eocd.writeUInt16LE(files.length, 8)
eocd.writeUInt16LE(files.length, 10)
eocd.writeUInt32LE(centralBuf.length, 12)
eocd.writeUInt32LE(offset, 16)
eocd.writeUInt16LE(0, 20)

const zip = Buffer.concat([...locals, centralBuf, eocd])

// ---- 最小 TAR 写入（ustar）—— DSH 直装用的 .tgz -----------------------------
/**
 * 一个 ustar 头 512 字节。文件名超过 100 字节时用 prefix 字段（最多 155），
 * 两边拼起来就是完整路径 —— 本包的路径都很短，用不上太长的情况。
 */
function tarHeader(name, size, mode = 0o644) {
  const buf = Buffer.alloc(512)
  const put = (str, off, len) => buf.write(str, off, len, 'utf8')
  const octal = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0'

  let prefix = ''
  let base = name
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 100)
    prefix = name.slice(0, cut)
    base = name.slice(cut + 1)
  }
  put(base, 0, 100)
  put(octal(mode, 8), 100, 8)
  put(octal(0, 8), 108, 8) // uid
  put(octal(0, 8), 116, 8) // gid
  put(octal(size, 12), 124, 12)
  put(octal(Math.floor(Date.now() / 1000), 12), 136, 12)
  put('        ', 148, 8) // 校验和先填空格
  buf.write('0', 156, 1, 'utf8') // typeflag：普通文件
  put('ustar\0', 257, 6)
  put('00', 263, 2)
  put(prefix, 345, 155)

  let sum = 0
  for (const b of buf) sum += b
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return buf
}

const tarParts = []
for (const f of files) {
  const raw = readFileSync(f.abs)
  // npm 约定：tarball 里所有内容都在 package/ 下，pnpm 照着它解包
  tarParts.push(tarHeader(`package/${f.rel}`, raw.length), raw)
  const pad = (512 - (raw.length % 512)) % 512
  if (pad) tarParts.push(Buffer.alloc(pad))
}
tarParts.push(Buffer.alloc(1024)) // 两个全零块表示归档结束
const tgz = gzipSync(Buffer.concat(tarParts), { level: 9 })

// ---- 写出 -------------------------------------------------------------------
mkdirSync(OUT_DIR, { recursive: true })
const zipPath = join(OUT_DIR, `${NAME}-${VERSION}.zip`)
writeFileSync(zipPath, zip)
const tgzPath = join(OUT_DIR, `${NAME}-${VERSION}.tgz`)
writeFileSync(tgzPath, tgz)
/**
 * 稳定别名：GitHub Release 里上传**这一个**。
 * 安装地址写的是 releases/latest/download/<包名>.tgz —— GitHub 只按附件文件名查找，
 * 附件名带版本号的话，每次发版都得连 README 的安装地址一起改；不带版本号就永远指向最新一版。
 * 版本号由 tag 记录，版本化的 .tgz 仍然留在 dist/ 里存档。
 */
const aliasPath = join(OUT_DIR, `${NAME}.tgz`)
writeFileSync(aliasPath, tgz)

const shaOf = (buf) => createHash('sha256').update(buf).digest('hex')
const sha = shaOf(zip)
const shaTgz = shaOf(tgz)
writeFileSync(join(OUT_DIR, `${NAME}-${VERSION}.sha256.txt`),
  `${sha}  ${basename(zipPath)}\n${shaTgz}  ${basename(tgzPath)}\n${shaTgz}  ${basename(aliasPath)}\n`, 'utf8')

// ---- 报告 -------------------------------------------------------------------
const byDir = new Map()
for (const f of files) {
  const top = f.rel.includes('/') ? f.rel.split('/')[0] : '(根目录)'
  const cur = byDir.get(top) ?? { n: 0, bytes: 0 }
  cur.n += 1
  cur.bytes += statSync(f.abs).size
  byDir.set(top, cur)
}
console.log(`${NAME} ${VERSION}`)
console.log(`文件 ${files.length} 个`)
for (const [k, v] of [...byDir.entries()].sort()) {
  console.log(`  ${k.padEnd(18)} ${String(v.n).padStart(3)} 个   ${(v.bytes / 1024).toFixed(1).padStart(8)} KB`)
}
console.log(`\n${tgzPath}   ← DSH 直装用这个（贴这个 URL/路径到插件安装框）`)
console.log(`  ${(tgz.length / 1024).toFixed(0)} KB   sha256 ${shaTgz}`)
console.log(`\n${aliasPath}   ← 发 Release 时上传这个（名称固定，安装地址才不会随版本失效）`)
console.log(`  ${(tgz.length / 1024).toFixed(0)} KB   sha256 ${shaTgz}`)
console.log(`\n${zipPath}   ← 看源码 / 手动解压后按本地目录安装`)
console.log(`  ${(zip.length / 1024).toFixed(0)} KB   sha256 ${sha}`)
