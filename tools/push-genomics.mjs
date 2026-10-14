/**
 * 用真实的宿主代码往真实的状态目录推一张基因组学图。
 *
 * 为什么要这么绕：`sci_viz_genomics` 是新工具，运行中的宿主还没加载它（ESM 按 URL 缓存，
 * 要重启），所以走不了工具那条路。但状态文件是唯一真源 —— 开一个新进程 import 宿主模块、
 * 用它自己的 buildGenomicsPanel 生成文档、写进 state/current.json，面板照样会显示。
 *
 * 用法：node tools/push-genomics.mjs <kind>
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const P = join(HERE, '..')

const tools = new Map()
const ctx = {
  logger: { warn() {}, info() {}, error() {} },
  effect: (b) => b(),
  get: (n) => (n === 'tools' ? { register: (d) => { tools.set(d.name, d); return () => {} } } : undefined),
  webServer: { register: () => () => {} },
}
const host = await import(`file://${join(P, 'lib', 'index.js').replace(/\\/g, '/')}`)
// stateDir 指向插件真实的状态目录 → 直接写进面板正在读的那个文件
host.apply(ctx, { stateDir: join(P, 'state') })
await new Promise((r) => setTimeout(r, 400))

const CASES = {
  phylo: {
    title: '结核分枝杆菌复合群 · 进化树',
    note: 'Newick 输入 · 分支长度 + bootstrap 支持率 · L1/L2/L4 按谱系着色',
    newick: '((((L1_ICDC:0.0212,L1_CTRI:0.0198)96:0.0087,'
      + '(L2_Beijing:0.0091,L2_HN:0.0104)94:0.0092)88:0.0135,'
      + '(L3_CAS:0.0187,(L4_H37Rv:0.0034,L4_CDC1551:0.0041)99:0.0076)91:0.0121)85:0.0203,'
      + '((L5_AFRI:0.0231,(L6_CANETTI:0.0255,L9_BOVIS:0.0288)93:0.0140)87:0.0165,'
      + '(L7_lineage7:0.0266,L8_lineage8:0.0271)90:0.0172)84:0.0194)',
    groups: [
      { name: 'L1', color: '#4c9aff', labels: ['L1_*'] },
      { name: 'L2 Beijing', color: '#e56b6f', labels: ['L2_*'] },
      { name: 'L4', color: '#f2a33c', labels: ['L4_*'] },
    ],
  },
  msa: {
    title: 'katG 片段多序列比对',
    note: '8 条序列 · 残基按化学性质着色 · 顶部为逐列保守度',
    sequences: [
      { name: 'H37Rv_ref', seq: 'MSTPGPQRWLAEQGHTVVAGVVGALAAALVLVLVAALLRWRPASL' },
      { name: 'INH_res_1', seq: 'MSTPGPQRWLAEQGHTVVAGVVGALAAALVLVLVAALLRWRPASL' },
      { name: 'INH_res_2', seq: 'MSTPGPQRWLAEQGHTVVAGVVGALAAALVLVLVAAFLRWRPASL' },
      { name: 'INH_res_3', seq: 'MSTPGPQRWLAEQGHTVVAGVVGALAAALVLVLVAAFFRWRPASL' },
      { name: 'Clinical_4', seq: 'MSTPGPQRWLAEQGHTVVAGVVGALAAALVLVLVAALLRWRPASL' },
      { name: 'Clinical_5', seq: 'MSTPGPQRWLAEQGHNVVAGVVGALAAALVLVLVAALLRWRPPSL' },
      { name: 'Bovis_6', seq: 'MSTPGPQRWLAEQGHTVVAGVVGALAAALVLVLVAALLRWRPASL' },
      { name: 'Outgroup_7', seq: 'MSTPGPQKWLAEQGHNVVAGVVGSLAAALILVLVAALLRWRPAPL' },
    ],
  },
  enrich: {
    title: '耐药株差异表达基因 · KEGG 富集',
    note: '气泡大小 = 基因数，颜色 = -log10(p)，描边 = 分类（KEGG / GO）',
    terms: [
      { term: 'ABC transporters', count: 24, p: 3.1e-9, ratio: 0.31, category: 'KEGG' },
      { term: 'Two-component system', count: 18, p: 8.4e-8, ratio: 0.23, category: 'KEGG' },
      { term: 'Bacterial secretion system', count: 11, p: 2.7e-6, ratio: 0.14, category: 'KEGG' },
      { term: 'Fatty acid biosynthesis', count: 9, p: 1.1e-5, ratio: 0.12, category: 'KEGG' },
      { term: 'Peptidoglycan biosynthesis', count: 7, p: 4.3e-5, ratio: 0.09, category: 'KEGG' },
      { term: 'Oxidative phosphorylation', count: 12, p: 1.6e-4, ratio: 0.15, category: 'KEGG' },
      { term: 'Response to antibiotic (GO:0046677)', count: 15, p: 3.9e-4, ratio: 0.19, category: 'GO' },
      { term: 'Drug transmembrane transport (GO:0006855)', count: 10, p: 8.2e-4, ratio: 0.13, category: 'GO' },
      { term: 'Mycolic acid metabolic process', count: 6, p: 2.4e-3, ratio: 0.08, category: 'GO' },
      { term: 'DNA repair (GO:0006281)', count: 8, p: 5.1e-3, ratio: 0.10, category: 'GO' },
    ],
  },
  genome: {
    title: 'H37Rv 全基因组变异分布',
    note: 'SNP 画在染色体条上方、INDEL 与 CNV 在下方 · 质粒已给最小可见宽度',
    chromosomes: [
      { name: 'chr (4.41 Mb)', length: 4411532 },
      { name: 'pncA plasmid', length: 4300 },
      { name: 'pMZ1', length: 11000 },
      { name: 'pRS7', length: 7500 },
    ],
    variants: [
      { chrom: 'chr (4.41 Mb)', pos: 2153889, type: 'SNP', label: 'katG S315T' },
      { chrom: 'chr (4.41 Mb)', pos: 761110, type: 'SNP', label: 'rpoB S450L' },
      { chrom: 'chr (4.41 Mb)', pos: 7570, type: 'SNP', label: 'gyrA D94G' },
      { chrom: 'chr (4.41 Mb)', pos: 1673425, type: 'SNP', label: 'pncA W68R' },
      { chrom: 'chr (4.41 Mb)', pos: 1472764, type: 'INDEL', label: 'embB M306I' },
      { chrom: 'chr (4.41 Mb)', pos: 3620000, type: 'CNV' },
      { chrom: 'pncA plasmid', pos: 1200, type: 'SNP' },
      { chrom: 'pMZ1', pos: 5400, type: 'INDEL' },
      { chrom: 'pRS7', pos: 3100, type: 'SNP' },
    ],
  },
  coverage: {
    title: 'gyrA 区域测序覆盖度',
    note: '三条样本轨道（各带自己的峰值）+ 基因模型 · pysam / deeptools 的典型输出',
    tracks: [
      { name: 'H37Rv (对照)', points: Array.from({ length: 60 }, (_, i) => [i * 400, 120 + Math.round(Math.sin(i / 4) * 60 + Math.cos(i / 2.4) * 35)]) },
      { name: '耐药株 A', points: Array.from({ length: 60 }, (_, i) => [i * 400, 95 + Math.round(Math.sin(i / 4 + 1) * 55 + Math.cos(i / 2.4) * 30)]) },
      { name: '耐药株 B', points: Array.from({ length: 60 }, (_, i) => [i * 400, 60 + Math.round(Math.sin(i / 3 + 2) * 25)]) },
    ],
    genes: [
      { name: 'gyrA', start: 4000, end: 4500 },
      { name: 'Rv0007', start: 9000, end: 9800 },
    ],
  },
  volcano: {
    title: '耐药株 vs 敏感株 · 差异表达',
    note: '橙色上调、蓝色下调、灰色不显著；阈值 |log2FC| ≥ 1 且 p < 0.05',
    points: [
      ...Array.from({ length: 260 }, () => [(Math.random() - 0.5) * 2, Math.abs(Math.random() * 1.2)]),
      ...Array.from({ length: 40 }, () => [1 + Math.random() * 4.5, 1.4 + Math.random() * 7]),
      ...Array.from({ length: 34 }, () => [-(1 + Math.random() * 4), 1.4 + Math.random() * 6]),
    ],
    labels: [
      { name: 'katG', x: 4.8, y: 7.9 },
      { name: 'inhA', x: 3.6, y: 6.2 },
      { name: 'rpoB', x: -3.9, y: 6.8 },
      { name: 'pncA', x: -2.8, y: 4.1 },
    ],
  },
}

const kind = process.argv[2] || 'phylo'
const args = CASES[kind]
if (!args) {
  console.log(`不认识的 kind：${kind}（可选 ${Object.keys(CASES).join(' / ')}）`)
  process.exit(1)
}
const def = tools.get('sci_viz_genomics')
if (!def) {
  console.log('工具没注册')
  process.exit(1)
}
const value = await def.execute({ kind, ...args }, {})
console.log(value.summary)
const doc = JSON.parse(readFileSync(join(P, 'state', 'current.json'), 'utf8')).doc
console.log(`已写入 state/current.json：section=${doc.section} panels=${doc.panels.length} kind=${doc.panels[0].kind}`)
