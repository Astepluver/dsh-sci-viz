/**
 * 结构解析器冒烟测试：解析真实的 PDB / mmCIF，检查文档尺寸与字段。
 *
 * 测试文件不在仓库里（AlphaFold 预测结构不是本项目的产物，体积也不小）。
 * 开发机上它们在 <测试数据目录>；换台机器用 SCIVIZ_FIXTURES 指过去即可。
 * 一个都找不到时，只跑不依赖文件的「位点写法解析」，并如实写明跳过了什么 —— 不让自检永远是红的。
 */
import { readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseStructure, compileStructure, parseSiteSpec } from '../lib/core/structure.js'

const FIXTURES = process.env.SCIVIZ_FIXTURES || '<测试数据目录>'
const FILES = [
  ['AF_O53740.pdb', 'pdb'],
  ['AF_P9WJV1.pdb', 'pdb'],
  ['af3/fold_2304plus3unit_model_0.cif', 'mmcif'],
  ['af3b/fold_2dvar_model_0.cif', 'mmcif'],
]

let failed = 0
let ran = 0
const missing = []
for (const [rel, format] of FILES) {
  const path = join(FIXTURES, rel)
  if (!existsSync(path)) {
    missing.push(rel)
    continue
  }
  ran += 1
  try {
    const bytes = statSync(path).size
    const text = readFileSync(path, 'utf8')
    const t0 = Date.now()
    const parsed = parseStructure(text, format)
    const doc = compileStructure(parsed, {
      path,
      format,
      bytes,
      label: rel,
      sourceId: '',
    })
    const ms = Date.now() - t0
    const json = JSON.stringify(doc)
    console.log(
      `${rel.padEnd(34)} ${format.padEnd(6)} ` +
      `in=${(bytes / 1024).toFixed(0)}KB out=${(json.length / 1024).toFixed(0)}KB ` +
      `atoms=${doc.atoms.count} res=${doc.stats.residues} chains=${doc.stats.chains} ` +
      `lig=${doc.stats.ligands} ss=${doc.stats.ssSource} R=${doc.source.resolution ?? '-'} ` +
      `t=${ms}ms`,
    )
    if (doc.atoms.count === 0) throw new Error('原子数为 0')
    if (doc.ca.length === 0) throw new Error('没有 Cα 原子')
    if (!Number.isFinite(doc.bbox.radius) || doc.bbox.radius <= 0) throw new Error('包围盒半径异常')
    const chain = doc.chains.find((c) => c.residueCount > 4)
    if (chain) console.log(`    chain ${chain.id}: ${chain.residueCount} res, seq[:60]=${chain.seq.slice(0, 60)}`)
  } catch (e) {
    failed += 1
    console.log(`FAIL ${rel}: ${e.message}`)
  }
}
if (missing.length) {
  console.log(`\n跳过 ${missing.length} 个仓库里没有的测试文件：${missing.join('、')}`)
  console.log(`  想跑满：SCIVIZ_FIXTURES=<目录> node tools/smoke-structure.mjs（当前目录 ${FIXTURES}）`)
}
console.log(`\n解析了 ${ran} 个真实结构文件${failed ? `，${failed} 个失败` : '，全部通过'}`)
/**
 * 「一个文件都没解析」不等于通过 —— 那是**没验证**。
 * 用退出码 2 把它和「通过(0) / 失败(1)」区分开，免得在别人的机器上
 * 解析器整个坏掉、脚本却报绿灯。
 */
if (ran === 0) {
  console.log('没有可解析的测试文件：本次未验证解析器（退出码 2，不是通过）')
  process.exit(2)
}

// 位点写法解析
const SITES = ['S315T', 's315t', 'S315', '315', 'D94G', 'A:315', 'A:S315T', 'katG S315T', '']
console.log('\n位点解析:')
for (const s of SITES) console.log(`  ${JSON.stringify(s).padEnd(14)} -> ${JSON.stringify(parseSiteSpec(s))}`)

process.exit(failed ? 1 : 0)
