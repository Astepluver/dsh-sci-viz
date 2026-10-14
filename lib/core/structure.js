/**
 * dsh-sci-viz — 结构解析与几何编译（宿主侧，零依赖）
 *
 * 输入：PDB 或 mmCIF 文本（本地文件 / 字符串 / 远程下载的字节）
 * 输出：一份紧凑的「结构文档」，交给浏览器端三维渲染器。
 *
 * 设计取舍：
 *  - 解析放在宿主（Node）一侧做一次，浏览器只做投影与绘制 —— 命令式渲染器不需要
 *    再带一个解析器，客户端体积和往返数据量都更小。
 *  - 坐标量化到 0.001 Å（×1000 整数），数字/字符串全部走字典索引，JSON 里没有
 *    重复的长键名；一个 300 残基蛋白约 100–150 KB。
 *  - 二级结构优先用文件自带的 HELIX/SHEET（mmCIF: _struct_conf/_struct_sheet_range）；
 *    AlphaFold 这类没有注释的 PDB 用 Cα 距离启发式补一个可用的近似值，并在
 *    返回里标明来源（ssSource: 'file' | 'geometry' | 'none'）。
 *
 * @module dsh-sci-viz/core/structure
 */

const MAX_ATOMS = 24000

/** 常见元素的范德华半径（Å）与颜色（CPK 风格，客户端也用同一张表）。 */
const ELEMENT_TABLE = [
  ['C', 1.70, '#9aa4ad'],
  ['N', 1.55, '#4d7fe0'],
  ['O', 1.52, '#e0483f'],
  ['S', 1.80, '#d8b422'],
  ['P', 1.80, '#e08a2b'],
  ['H', 1.20, '#d8dde3'],
  ['F', 1.47, '#6fd44a'],
  ['CL', 1.75, '#4ac96f'],
  ['BR', 1.85, '#a4553a'],
  ['I', 1.98, '#7a49c8'],
  ['FE', 1.80, '#c96a2a'],
  ['ZN', 1.39, '#7f8fa4'],
  ['MG', 1.73, '#4ad0a0'],
  ['MN', 1.79, '#9a7fd0'],
  ['CA', 1.94, '#57c9a8'],
  ['NA', 2.27, '#8f7fe0'],
  ['K', 2.75, '#9a6fe0'],
  ['SE', 1.90, '#e0a02b'],
  ['CU', 1.40, '#c07a3a'],
  ['NI', 1.63, '#6fb0a0'],
  ['CO', 1.70, '#d06a8a'],
  ['CD', 1.58, '#c0a060'],
  ['HG', 1.55, '#b0b0c0'],
  ['BR', 1.85, '#a4553a'],
]

/** 元素名 → 索引；未知元素归到 0。 */
const ELEMENT_INDEX = new Map(ELEMENT_TABLE.map(([el], i) => [el, i]))

/** 三字母 → 一字母氨基酸表（序列展示与突变位点解析用）。 */
const AA3TO1 = {
  ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLN: 'Q', GLU: 'E', GLY: 'G',
  HIS: 'H', ILE: 'I', LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F', PRO: 'P', SER: 'S',
  THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V', MSE: 'M', SEC: 'U', PYL: 'O',
  ASX: 'B', GLX: 'Z', UNK: 'X', HID: 'H', HIE: 'H', HIP: 'H', CYX: 'C', CYM: 'C',
}

const AA1TO3 = Object.fromEntries(Object.entries(AA3TO1).map(([k, v]) => [v, k]))

/** 把可能带空格的元素字段规整成表内键。 */
function normalizeElement(raw, atomName, resName) {
  let el = (raw ?? '').trim().toUpperCase()
  if (el === '') {
    // PDB 里元素列可缺省：从原子名推断（去前导数字，取前 1–2 个字母）
    const name = (atomName ?? '').replace(/^\d+/, '').trim()
    el = name.length >= 2 && ELEMENT_INDEX.has(name.slice(0, 2)) ? name.slice(0, 2) : name.slice(0, 1)
  }
  if (el === 'D') el = 'H'
  if (!ELEMENT_INDEX.has(el)) {
    // 金属离子等按两字母试一次，再退回单字母，最后归到 C 之外的默认桶
    const upper = el.slice(0, 2)
    if (ELEMENT_INDEX.has(upper)) el = upper
    else el = ELEMENT_INDEX.has(el.slice(0, 1)) ? el.slice(0, 1) : 'C'
  }
  void resName
  return el
}

/** 建立字符串字典：值 → 索引，同时返回数组。 */
class Dictionary {
  constructor() {
    this.map = new Map()
    this.list = []
  }

  id(value) {
    const key = value ?? ''
    let index = this.map.get(key)
    if (index === undefined) {
      index = this.list.length
      this.list.push(key)
      this.map.set(key, index)
    }
    return index
  }
}

/** 解析 PDB 文本。 */
function parsePdb(text) {
  const chains = []
  const chainIndex = new Map()
  const atoms = []
  const ssRanges = []
  let title = ''
  let resolution = Number.NaN
  let method = ''
  let model = 0
  let truncated = 0

  const chainFor = (id) => {
    const key = id === ' ' || id === '' ? '_' : id
    let idx = chainIndex.get(key)
    if (idx === undefined) {
      idx = chains.length
      chains.push({ id: key })
      chainIndex.set(key, idx)
    }
    return idx
  }

  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const rec = line.slice(0, 6).trim()
    if (rec === 'ENDMDL') break
    if (rec === 'MODEL') {
      model += 1
      if (model > 1) break
      continue
    }
    if (rec === 'TITLE') {
      title += ` ${line.slice(10).trim()}`
      continue
    }
    if (rec === 'EXPDTA') {
      method = line.slice(10).trim()
      continue
    }
    if (rec === 'REMARK' && line.startsWith('REMARK   2 RESOLUTION.')) {
      const m = /RESOLUTION\.\s*([\d.]+)/.exec(line)
      if (m) resolution = Number(m[1])
      continue
    }
    if (rec === 'HELIX') {
      const chainA = line[19]
      const start = Number.parseInt(line.slice(21, 25), 10)
      const chainB = line[31]
      const end = Number.parseInt(line.slice(33, 37), 10)
      if (Number.isFinite(start) && Number.isFinite(end)) {
        ssRanges.push({ chain: chainA, start, end, type: 'H' })
      }
      void chainB
      continue
    }
    if (rec === 'SHEET') {
      const chainA = line[21]
      const start = Number.parseInt(line.slice(22, 26), 10)
      const chainB = line[32]
      const end = Number.parseInt(line.slice(33, 37), 10)
      if (Number.isFinite(start) && Number.isFinite(end)) {
        ssRanges.push({ chain: chainA, start, end, type: 'E' })
      }
      void chainB
      continue
    }
    if (rec !== 'ATOM' && rec !== 'HETATM') continue
    const altLoc = line[16]
    if (altLoc !== ' ' && altLoc !== 'A') continue
    if (atoms.length >= MAX_ATOMS) {
      truncated += 1
      continue
    }
    const x = Number.parseFloat(line.slice(30, 38))
    const y = Number.parseFloat(line.slice(38, 46))
    const z = Number.parseFloat(line.slice(46, 54))
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    const b = Number.parseFloat(line.slice(60, 66))
    atoms.push({
      chain: chainFor(line[21]),
      resSeq: Number.parseInt(line.slice(22, 26), 10) || 0,
      iCode: line[26] === ' ' ? '' : line[26],
      resName: line.slice(17, 20).trim().toUpperCase(),
      atomName: line.slice(12, 16).trim(),
      element: normalizeElement(line.slice(76, 78), line.slice(12, 16), line.slice(17, 20)),
      x,
      y,
      z,
      b: Number.isFinite(b) ? b : 0,
      het: rec === 'HETATM',
    })
  }
  return { atoms, chains, ssRanges, title: title.trim(), resolution, method, truncated }
}

/** 解析 mmCIF 文本（只取第一个 model 的 _atom_site 循环 + 二级结构循环）。 */
function parseCif(text) {
  const lines = text.split(/\r?\n/)
  let title = ''
  let resolution = Number.NaN
  let method = ''

  for (const line of lines) {
    if (line.startsWith('_struct.title')) {
      const m = /_struct\.title\s+(.+)$/.exec(line)
      if (m) title = m[1].replace(/^['"]|['"]$/g, '').trim()
    } else if (line.startsWith('_refine.ls_d_res_high')) {
      const m = /([\d.]+)\s*$/.exec(line)
      if (m) resolution = Number(m[1])
    } else if (line.startsWith('_exptl.method')) {
      const m = /_exptl\.method\s+(.+)$/.exec(line)
      if (m) method = m[1].replace(/^['"]|['"]$/g, '').trim()
    }
    if (title && method && Number.isFinite(resolution)) break
  }

  /** 读一个 loop_：返回 { tags, rows }。 */
  const readLoop = (startIndex) => {
    const tags = []
    let i = startIndex
    while (i < lines.length && lines[i].trim().startsWith('_')) {
      tags.push(lines[i].trim())
      i += 1
    }
    const rows = []
    let row = []
    for (; i < lines.length; i += 1) {
      const raw = lines[i]
      const trimmed = raw.trim()
      if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('loop_') ||
          trimmed.startsWith('_') || trimmed.startsWith('data_')) break
      // 按空格切分，但保留引号内内容
      const tokens = trimmed.match(/'[^']*'|"[^"]*"|\S+/g) ?? []
      for (const tok of tokens) {
        row.push(tok.replace(/^['"]|['"]$/g, ''))
        if (row.length === tags.length) {
          rows.push(row)
          row = []
        }
      }
    }
    return { tags, rows, endIndex: i }
  }

  const findLoop = (prefix) => {
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].trim() === 'loop_') {
        const next = i + 1
        if (next < lines.length && lines[next].trim().startsWith(prefix)) return readLoop(next)
      }
    }
    return null
  }

  const atomLoop = findLoop('_atom_site.')
  if (!atomLoop) throw new Error('mmCIF：找不到 _atom_site 循环（该文件可能只含坐标之外的类别）')
  const col = (name) => atomLoop.tags.findIndex((t) => t === name || t.endsWith(`.${name}`))
  const cGroup = col('group_PDB')
  const cAtom = col('label_atom_id') >= 0 ? col('label_atom_id') : col('auth_atom_id')
  const cComp = col('label_comp_id') >= 0 ? col('label_comp_id') : col('auth_comp_id')
  const cAsym = col('label_asym_id') >= 0 ? col('label_asym_id') : col('auth_asym_id')
  const cSeq = col('auth_seq_id') >= 0 ? col('auth_seq_id') : col('label_seq_id')
  const cX = col('Cartn_x')
  const cY = col('Cartn_y')
  const cZ = col('Cartn_z')
  const cB = col('B_iso_or_equiv')
  const cEl = col('type_symbol')
  const cModel = col('pdbx_PDB_model_num')
  if (cX < 0 || cY < 0 || cZ < 0) throw new Error('mmCIF：_atom_site 缺少 Cartn_x/y/z 列')

  const chains = []
  const chainIndex = new Map()
  const atoms = []
  let truncated = 0
  let firstModel = ''
  const chainFor = (id) => {
    const key = id || '_'
    let idx = chainIndex.get(key)
    if (idx === undefined) {
      idx = chains.length
      chains.push({ id: key })
      chainIndex.set(key, idx)
    }
    return idx
  }
  for (const row of atomLoop.rows) {
    if (cModel >= 0) {
      if (firstModel === '') firstModel = row[cModel]
      else if (row[cModel] !== firstModel) continue
    }
    if (atoms.length >= MAX_ATOMS) {
      truncated += 1
      continue
    }
    const x = Number.parseFloat(row[cX])
    const y = Number.parseFloat(row[cY])
    const z = Number.parseFloat(row[cZ])
    if (!Number.isFinite(x)) continue
    atoms.push({
      chain: chainFor(cAsym >= 0 ? row[cAsym] : '_'),
      resSeq: Number.parseInt(cSeq >= 0 ? row[cSeq] : '0', 10) || 0,
      iCode: '',
      resName: (cComp >= 0 ? row[cComp] : 'UNK').toUpperCase(),
      atomName: cAtom >= 0 ? row[cAtom] : 'X',
      element: normalizeElement(cEl >= 0 ? row[cEl] : '', cAtom >= 0 ? row[cAtom] : '', ''),
      x,
      y,
      z,
      b: cB >= 0 && Number.isFinite(Number.parseFloat(row[cB])) ? Number.parseFloat(row[cB]) : 0,
      het: cGroup >= 0 ? row[cGroup].toUpperCase() === 'HETATM' : false,
    })
  }

  const ssRanges = []
  const confLoop = findLoop('_struct_conf.')
  if (confLoop) {
    const tChain = confLoop.tags.findIndex((t) => t.endsWith('.beg_auth_asym_id') || t.endsWith('.beg_label_asym_id'))
    const tStart = confLoop.tags.findIndex((t) => t.endsWith('.beg_auth_seq_id') || t.endsWith('.beg_label_seq_id'))
    const tEnd = confLoop.tags.findIndex((t) => t.endsWith('.end_auth_seq_id') || t.endsWith('.end_label_seq_id'))
    if (tChain >= 0 && tStart >= 0 && tEnd >= 0) {
      for (const row of confLoop.rows) {
        const start = Number.parseInt(row[tStart], 10)
        const end = Number.parseInt(row[tEnd], 10)
        if (Number.isFinite(start) && Number.isFinite(end)) {
          ssRanges.push({ chain: row[tChain], start, end, type: 'H' })
        }
      }
    }
  }
  const sheetLoop = findLoop('_struct_sheet_range.')
  if (sheetLoop) {
    const tChain = sheetLoop.tags.findIndex((t) => t.endsWith('.beg_auth_asym_id') || t.endsWith('.beg_label_asym_id'))
    const tStart = sheetLoop.tags.findIndex((t) => t.endsWith('.beg_auth_seq_id') || t.endsWith('.beg_label_seq_id'))
    const tEnd = sheetLoop.tags.findIndex((t) => t.endsWith('.end_auth_seq_id') || t.endsWith('.end_label_seq_id'))
    if (tChain >= 0 && tStart >= 0 && tEnd >= 0) {
      for (const row of sheetLoop.rows) {
        const start = Number.parseInt(row[tStart], 10)
        const end = Number.parseInt(row[tEnd], 10)
        if (Number.isFinite(start) && Number.isFinite(end)) {
          ssRanges.push({ chain: row[tChain], start, end, type: 'E' })
        }
      }
    }
  }
  return { atoms, chains, ssRanges, title, resolution, method, truncated }
}

/** 依据文件头判断格式并解析。 */
export function parseStructure(text, format) {
  const head = text.slice(0, 4096)
  const isCif = format === 'mmcif' || format === 'cif' ||
    /^data_/m.test(head) || head.includes('_atom_site.')
  return isCif ? parseCif(text) : parsePdb(text)
}

/** 需要的原子：主链 N/CA/C/O + 侧链 + 配体，全部保留（用于空间填充/球棍）。 */
const BACKBONE = new Set(['N', 'CA', 'C', 'O', 'OXT'])

/**
 * 由 Cα 距离启发式推断二级结构（用于没有 HELIX/SHEET 注释的结构，例如 AlphaFold）。
 * 判据取经典的 Cα(i)–Cα(i+3) / Cα(i)–Cα(i+4) 窗口，够画卡通图用，不作为科学结论。
 */
function ssFromGeometry(caList) {
  const n = caList.length
  const type = new Array(n).fill('C')
  const dist = (i, j) => {
    const a = caList[i]
    const b = caList[j]
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
  }
  for (let i = 0; i + 3 < n; i += 1) {
    if (caList[i].chain !== caList[i + 3].chain) continue
    const d3 = dist(i, i + 3)
    const d4 = i + 4 < n && caList[i + 4].chain === caList[i].chain ? dist(i, i + 4) : Number.NaN
    const d2 = i + 2 < n && caList[i + 2].chain === caList[i].chain ? dist(i, i + 2) : Number.NaN
    if (d3 < 6.2 && Number.isFinite(d4) && d4 < 7.2) type[i] = 'H'
    else if (Number.isFinite(d2) && d2 > 6.2 && d3 > 8.6) type[i] = 'E'
  }
  return type
}

/**
 * 把解析结果编译成给浏览器的结构文档。
 * @param {object} parsed parseStructure 的返回值
 * @param {object} opts { label, sourceId, sourceUrl, format }
 */
export function compileStructure(parsed, opts = {}) {
  const { atoms, chains } = parsed
  if (atoms.length === 0) throw new Error('这个文件里没有解析出任何原子坐标')

  const resNameDict = new Dictionary()
  const atomNameDict = new Dictionary()
  const elementDict = new Dictionary()

  // 残基键：链 + 残基号(+插入码)，用于序列、Cα 索引、突变位点匹配
  const residueKey = (a) => `${a.chain}\u0000${a.resSeq}\u0000${a.iCode}`
  const residueOrder = []
  const residueMap = new Map()
  const caByResidue = new Map()

  const packedAtoms = []
  for (let i = 0; i < atoms.length; i += 1) {
    const a = atoms[i]
    const key = residueKey(a)
    let res = residueMap.get(key)
    if (res === undefined) {
      res = {
        key,
        chain: a.chain,
        resSeq: a.resSeq,
        iCode: a.iCode,
        resName: a.resName,
        het: a.het,
        atomIndices: [],
      }
      residueMap.set(key, res)
      residueOrder.push(res)
    }
    res.atomIndices.push(packedAtoms.length)
    packedAtoms.push([
      a.chain,
      a.resSeq,
      resNameDict.id(a.resName),
      atomNameDict.id(a.atomName),
      Math.round(a.x * 1000),
      Math.round(a.y * 1000),
      Math.round(a.z * 1000),
      elementDict.id(a.element),
      Math.round(Math.max(0, Math.min(255, a.b / 5))),
      a.het ? 1 : 0,
    ])
    if (a.atomName === 'CA' && !caByResidue.has(key)) caByResidue.set(key, packedAtoms.length - 1)
  }

  // ---- 二级结构：文件注释优先，缺失时用几何启发式 ----
  const ssByResidue = new Map()
  let ssSource = 'none'
  for (const range of parsed.ssRanges) {
    ssSource = 'file'
    for (let r = range.start; r <= range.end; r += 1) {
      ssByResidue.set(`${range.chain === ' ' ? '_' : range.chain}\u0000${r}\u00001`, range.type)
      ssByResidue.set(`${range.chain === ' ' ? '_' : range.chain}\u0000${r}\u00000`, range.type)
    }
  }

  // 每条链的 Cα 序列
  const chainsOut = chains.map((c, index) => ({
    index,
    id: c.id,
    residueCount: 0,
    first: null,
    last: null,
    seq: '',
    hetCount: 0,
  }))
  const caList = []
  for (const res of residueOrder) {
    const out = chainsOut[res.chain]
    if (!out) continue
    if (res.het) {
      out.hetCount += 1
      continue
    }
    out.residueCount += 1
    if (out.first === null) out.first = res.resSeq
    out.last = res.resSeq
    const one = AA3TO1[res.resName] ?? 'X'
    out.seq += one
    const caIdx = caByResidue.get(res.key)
    if (caIdx !== undefined) {
      caList.push({ chain: res.chain, resSeq: res.resSeq, iCode: res.iCode, atomIndex: caIdx, ...indexCoords(packedAtoms[caIdx]) })
    }
  }

  if (ssSource === 'none' && caList.length >= 6) {
    const guess = ssFromGeometry(caList)
    for (let i = 0; i < caList.length; i += 1) {
      ssByResidue.set(`${caList[i].chain}\u0000${caList[i].resSeq}\u0000${caList[i].iCode === '' ? 0 : 1}`, guess[i])
    }
    ssSource = 'geometry'
  }

  const caOut = caList.map((c) => [
    c.chain,
    c.resSeq,
    ssByResidue.get(`${c.chain}\u0000${c.resSeq}\u00001`) ?? ssByResidue.get(`${c.chain}\u0000${c.resSeq}\u00000`) ?? 'C',
    c.atomIndex,
  ])

  // ---- 配体 / 辅因子汇总 ----
  const hetGroups = new Map()
  for (const res of residueOrder) {
    if (!res.het) continue
    if (res.resName === 'HOH' || res.resName === 'WAT' || res.resName === 'DOD') continue
    const key = res.resName
    let g = hetGroups.get(key)
    if (g === undefined) {
      g = { name: key, count: 0, atoms: 0, chains: new Set() }
      hetGroups.set(key, g)
    }
    g.count += 1
    g.atoms += res.atomIndices.length
    g.chains.add(chains[res.chain]?.id ?? '?')
  }
  const ligands = [...hetGroups.values()]
    .map((g) => ({ name: g.name, copies: g.count, atoms: g.atoms, chains: [...g.chains] }))
    .sort((a, b) => b.atoms - a.atoms)
    .slice(0, 40)

  // ---- 包围盒（用于自动取景） ----
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (const a of packedAtoms) {
    const x = a[4] / 1000
    const y = a[5] / 1000
    const z = a[6] / 1000
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (z < minZ) minZ = z
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    if (z > maxZ) maxZ = z
  }
  const center = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2]
  const radius = Math.max(1, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2)
  let bMin = Infinity
  let bMax = -Infinity
  for (const a of packedAtoms) {
    if (a[8] < bMin) bMin = a[8]
    if (a[8] > bMax) bMax = a[8]
  }
  const residues = residueOrder.length
  const proteinResidues = residueOrder.filter((r) => !r.het).length

  return {
    kind: 'structure',
    title: opts.label || parsed.title || opts.sourceId || '未命名结构',
    source: {
      id: opts.sourceId ?? '',
      path: opts.path ?? '',
      url: opts.sourceUrl ?? '',
      format: opts.format ?? 'pdb',
      bytes: opts.bytes ?? 0,
      method: parsed.method || '',
      resolution: Number.isFinite(parsed.resolution) ? parsed.resolution : null,
    },
    atoms: {
      count: packedAtoms.length,
      truncated: parsed.truncated,
      rows: packedAtoms,
    },
    dict: {
      resName: resNameDict.list,
      atomName: atomNameDict.list,
      element: elementDict.list,
    },
    elements: ELEMENT_TABLE.map(([el, radius, color]) => ({ el, radius, color })),
    ca: caOut,
    ss: { source: ssSource, ranges: parsed.ssRanges.slice(0, 4000) },
    chains: chainsOut,
    ligands,
    bbox: { center, radius, min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    stats: {
      atoms: packedAtoms.length,
      residues,
      proteinResidues,
      chains: chainsOut.filter((c) => c.residueCount > 0).length,
      ligands: ligands.length,
      bFactorRange: packedAtoms.length ? [bMin * 5, bMax * 5] : [0, 0],
      ssSource,
    },
  }
}

/** 从打包行里取出坐标（Å）。 */
function indexCoords(row) {
  return { x: row[4] / 1000, y: row[5] / 1000, z: row[6] / 1000 }
}

/**
 * 解析突变位点写法，支持：
 *   "S315T" / "s315t" / "S315" / "315" / "D94G" / "A:315" / "A:S315T"
 * @returns {{chain: string|null, wildtype: string|null, resSeq: number, mutant: string|null}}
 */
export function parseSiteSpec(spec) {
  const text = String(spec ?? '').trim()
  const m = /^(?:([A-Za-z0-9]{1,4})\s*[:.]\s*)?([A-Za-z])?\s*(\d{1,5})\s*([A-Za-z])?$/.exec(text)
  if (!m) return null
  const [, chainRaw, wt, num, mut] = m
  let chain = chainRaw ?? null
  // 单字母链号与「野生型残基字母 + 位点」写法有歧义：A315T 里 A 是残基不是链。
  // 判定：只有当冒号/点明确出现时，前段才当链号。
  if (chain !== null && !/[:.]/.test(text)) chain = null
  if (chain !== null && chain.length > 2 && !/[:.]/.test(text)) chain = null
  return {
    chain,
    wildtype: wt ? wt.toUpperCase() : null,
    resSeq: Number.parseInt(num, 10),
    mutant: mut ? mut.toUpperCase() : null,
  }
}

/** 供宿主在文本里渲染一句人类可读的位点说明。 */
export function describeSite(site) {
  if (!site) return ''
  const parts = []
  if (site.chain) parts.push(`链 ${site.chain}`)
  parts.push(`残基 ${site.resSeq}`)
  const body = `${site.chain ? `${site.chain}:` : ''}${site.wildtype ?? ''}${site.resSeq}${site.mutant ?? ''}`
  void parts
  return body
}

/** 一字母 → 三字母（客户端展示用，也导出给工具描述）。 */
export function threeLetter(one) {
  return AA1TO3[String(one).toUpperCase()] ?? 'UNK'
}

/** 把一字母序列切成固定宽度，便于报告里换行显示。 */
export function wrapSequence(seq, width = 60) {
  const out = []
  for (let i = 0; i < seq.length; i += width) out.push(seq.slice(i, i + width))
  return out
}

export const __internals = {
  BACKBONE,
  ELEMENT_TABLE,
  ELEMENT_INDEX,
  MAX_ATOMS,
  parsePdb,
  parseCif,
  ssFromGeometry,
  AA3TO1,
}
