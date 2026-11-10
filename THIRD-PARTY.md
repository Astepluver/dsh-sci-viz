# 第三方技能来源与许可清单（THIRD-PARTY）

本仓库的 `LICENSE`（MIT）只覆盖插件本身的代码。`data/skill-pack.json.gz` 里打包的
226 个技能是**第三方作品**，各自适用其上游许可，**不适用 MIT**。

清单由 `data/skill-pack.json.gz` 里每个技能的 frontmatter 直接抽取（不手工转写）。
「来源」列取自 frontmatter 的 `source` / `repo`；没写就从缺。

## 许可分布

| 许可 | 技能数 |
| --- | --- |
| MIT | 91 |
| （未声明） | 47 |
| MIT license | 29 |
| BSD-3-Clause license | 13 |
| Apache-2.0 license | 12 |
| Apache-2.0 | 7 |
| BSD-3-Clause | 3 |
| MIT License | 3 |
| Unknown | 3 |
| 3 clause BSD license | 1 |
| 3-clause BSD license | 1 |
| Apache License, Version 2.0 | 1 |
| BSD license | 1 |
| BSD-2-Clause license | 1 |
| Biopython License Agreement | 1 |
| CC BY-NC-SA 4.0 | 1 |
| CC-BY-4.0 | 1 |
| GPL-2.0 license | 1 |
| GPL-3.0-or-later | 1 |
| GPLv3 license | 1 |
| PolyForm-Noncommercial-1.0.0 | 1 |
| Proprietary (API key required) | 1 |
| This skill is provided under the MIT License. IDC data itself has individual licensing (mostly CC-BY, some CC-NC) that must be respected when using the data. | 1 |
| https://creativecommons.org/licenses/by/4.0/ | 1 |
| https://github.com/matplotlib/matplotlib/tree/main/LICENSE | 1 |
| https://github.com/pola-rs/polars/blob/main/LICENSE | 1 |
| https://github.com/sympy/sympy/blob/master/LICENSE | 1 |

## 需要特别注意的条目

| 技能 | 许可 | 说明 |
| --- | --- | --- |
| `bioservices` | GPLv3 license | 强著佐权：再分发该技能（或其衍生）时须一并提供源代码 |
| `cobrapy` | GPL-2.0 license | 强著佐权：再分发该技能（或其衍生）时须一并提供源代码 |
| `deepspot-m` | PolyForm-Noncommercial-1.0.0 | PolyForm Noncommercial 1.0.0 —— 仅限非商业用途 |
| `etetoolkit` | GPL-3.0-or-later | 强著佐权：再分发该技能（或其衍生）时须一并提供源代码 |
| `glycoengineering` | Unknown | 上游标了 Unknown —— 再分发前需先确认许可 |
| `phylogenetics` | Unknown | 上游标了 Unknown —— 再分发前需先确认许可 |
| `primekg` | Unknown | 上游标了 Unknown —— 再分发前需先确认许可 |
| `rowan` | Proprietary (API key required) | Proprietary（需要 API key）—— 商用/再分发前请先取得授权 |
| `what-if-oracle` | CC BY-NC-SA 4.0 | CC BY-NC-SA 4.0 —— 非商业；再分发需署名并以相同方式共享 |

**连许可字段都没写的技能**（47 个）：上游没声明许可，不等于授权再分发。
这里如实标「（未声明）」。如果你是这些技能的作者、或希望某个技能从本包中移除，开 issue 即可，会尽快处理。

## 2. 2026-10-27 从 InkStone 导入的 4 个技能

来源平台：**书生·端砚 InkStone**（上海人工智能实验室）SCP 广场 — <https://discovery.intern-ai.org.cn/scp>

| 技能 | 平台条目 id | 作者 | 平台声明许可 |
|---|---|---|---|
| `clinical-imaging` | 772 | InkVell Inc. | MIT license |
| `bioimage-analysis` | 755 | InkVell Inc. | MIT license |
| `immunology-assays` | 867 | InkVell Inc. | MIT license |
| `cancer-genomics-analysis` | 763 | InkVell Inc. | MIT license |

导入方式：**正文原样保存，未修改技术内容**；仅在 frontmatter 追加
`source_platform` / `source_skill_id` / `source_url` / `retrieved_at`，
并在每个文件末尾追加「来源与许可」段。各文件正文内的 frontmatter 均保留原始
`license: MIT license` 与 `metadata.skill-author: InkVell Inc.`。

### MIT 许可文本（转录）

> 说明：来源平台**未随附完整许可文本与版权行**。下列为 MIT 许可的常见文本，
> 版权行以原作者/原条目声明为准；再分发前建议向作者索取正式 NOTICE。

```
MIT License

Copyright (c) InkVell Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 逐条清单

| # | 技能 | 许可 | 来源 |
| --- | --- | --- | --- |
| 1 | `adaptyv` | MIT | — |
| 2 | `alphagenome` | MIT | — |
| 3 | `analytical-method-validation` | MIT | — |
| 4 | `bacterial-amr-and-virulence` | MIT | — |
| 5 | `bacterial-genome-annotation` | MIT | — |
| 6 | `bacterial-genome-assembly` | MIT | — |
| 7 | `bacterial-phylogenomics` | MIT | — |
| 8 | `bacterial-plasmid-and-mobile-elements` | MIT | — |
| 9 | `bacterial-read-qc` | MIT | — |
| 10 | `bacterial-typing-and-serotyping` | MIT | — |
| 11 | `bacterial-variant-calling` | MIT | — |
| 12 | `bacterial-wgs-report` | MIT | — |
| 13 | `bacterial-wgs-router` | MIT | — |
| 14 | `benchling-integration` | MIT | — |
| 15 | `bgpt-paper-search` | MIT | — |
| 16 | `bulk-rnaseq` | MIT | — |
| 17 | `cellxgene-census` | MIT | — |
| 18 | `clinical-decision-support` | MIT | — |
| 19 | `clinical-reports` | MIT | — |
| 20 | `database-lookup` | MIT | — |
| 21 | `datalad` | MIT | — |
| 22 | `dnanexus-integration` | MIT | — |
| 23 | `dsh-benchmark-case` | MIT | — |
| 24 | `exa-search` | MIT | — |
| 25 | `exploratory-data-analysis` | MIT | — |
| 26 | `fluidsim` | MIT | — |
| 27 | `folklore-variant-evidence` | MIT | — |
| 28 | `generate-image` | MIT | — |
| 29 | `generic-migration` | MIT | — |
| 30 | `geniml` | MIT | — |
| 31 | `genomic-coordinates` | MIT | — |
| 32 | `genomic-intelligence` | MIT | — |
| 33 | `geopandas` | MIT | — |
| 34 | `get-available-resources` | MIT | — |
| 35 | `gtars` | MIT | — |
| 36 | `human-wgs-germline-pipeline` | MIT | — |
| 37 | `human-wgs-sv-and-cnv` | MIT | — |
| 38 | `hypogenic` | MIT | — |
| 39 | `hypothesis-generation` | MIT | — |
| 40 | `iso-standards-readiness` | MIT | — |
| 41 | `lab-hardware-cad` | MIT | — |
| 42 | `labarchive-integration` | MIT | — |
| 43 | `latchbio-integration` | MIT | — |
| 44 | `market-research-reports` | MIT | — |
| 45 | `markitdown` | MIT | — |
| 46 | `matlab` | MIT | — |
| 47 | `molecular-dynamics` | MIT | — |
| 48 | `ncats-arax` | MIT | — |
| 49 | `neurokit2` | MIT | — |
| 50 | `omero-integration` | MIT | — |
| 51 | `onekgpd` | MIT | — |
| 52 | `ontology-term-resolution` | MIT | — |
| 53 | `open-notebook` | MIT | — |
| 54 | `opentrons-integration` | MIT | — |
| 55 | `optimize-for-gpu` | MIT | — |
| 56 | `pacsomatic` | MIT | — |
| 57 | `paper-lookup` | MIT | — |
| 58 | `paperclip` | MIT | — |
| 59 | `paperzilla` | MIT | — |
| 60 | `parallel-web` | MIT | — |
| 61 | `pathml` | MIT | — |
| 62 | `pathogen-variant-surveillance` | MIT | — |
| 63 | `pathway-enrichment` | MIT | — |
| 64 | `peer-review` | MIT | — |
| 65 | `pi-agent` | MIT | — |
| 66 | `pkpd-modeling` | MIT | — |
| 67 | `pptx-posters` | MIT | — |
| 68 | `protocolsio-integration` | MIT | — |
| 69 | `pufferlib` | MIT | — |
| 70 | `pydicom` | MIT | — |
| 71 | `pylabrobot` | MIT | — |
| 72 | `pymatgen` | MIT | — |
| 73 | `pysam` | MIT | — |
| 74 | `pytdc` | MIT | — |
| 75 | `qutip` | MIT | — |
| 76 | `relion` | MIT | — |
| 77 | `relsa-severity-assessment` | MIT | — |
| 78 | `sanger-read-validation` | MIT | — |
| 79 | `scholar-evaluation` | MIT | — |
| 80 | `scientific-brainstorming` | MIT | — |
| 81 | `scientific-visualization` | MIT | — |
| 82 | `scientific-writing` | MIT | — |
| 83 | `scikit-survival` | MIT | — |
| 84 | `shap` | MIT | — |
| 85 | `simpy` | MIT | — |
| 86 | `tamarind` | MIT | — |
| 87 | `treatment-plans` | MIT | — |
| 88 | `uncertainty-and-units` | MIT | — |
| 89 | `usfiscaldata` | MIT | — |
| 90 | `waypoint-bio` | MIT | — |
| 91 | `wgs-toolchain-and-reproducibility` | MIT | — |
| 92 | `alphafold-database-fetch-and-analyze` | （未声明） | — |
| 93 | `alphagenome-single-variant-analysis` | （未声明） | — |
| 94 | `alphagenome-variant-impact-score` | （未声明） | — |
| 95 | `clinvar-database` | （未声明） | — |
| 96 | `dbsnp-database` | （未声明） | — |
| 97 | `dsh-upgrade-audit` | （未声明） | — |
| 98 | `encode-ccres-database` | （未声明） | — |
| 99 | `ensembl-database` | （未声明） | — |
| 100 | `foldseek-structural-search` | （未声明） | — |
| 101 | `gnomad-database` | （未声明） | — |
| 102 | `hugging-science` | （未声明） | — |
| 103 | `human-protein-atlas-database` | （未声明） | — |
| 104 | `infographics` | （未声明） | — |
| 105 | `interpro-database` | （未声明） | — |
| 106 | `jaspar-database` | （未声明） | — |
| 107 | `latex-posters` | （未声明） | — |
| 108 | `literature-search-europepmc` | （未声明） | — |
| 109 | `medical-evidence-appraisal` | （未声明） | — |
| 110 | `medical-language-polish` | （未声明） | — |
| 111 | `medical-literature-retrieval` | （未声明） | — |
| 112 | `medical-paper-reading` | （未声明） | — |
| 113 | `medical-paper-writing` | （未声明） | — |
| 114 | `medical-reference-format` | （未声明） | — |
| 115 | `nature-ppt` | （未声明） | — |
| 116 | `ncbi-sequence-fetch` | （未声明） | — |
| 117 | `pdb-database` | （未声明） | — |
| 118 | `plugin-fleet-sweep` | （未声明） | — |
| 119 | `plugin-heavy-dep` | （未声明） | — |
| 120 | `plugin-release` | （未声明） | — |
| 121 | `plugin-runtime-debug` | （未声明） | — |
| 122 | `plugin-test` | （未声明） | — |
| 123 | `plugin-upgrade` | （未声明） | — |
| 124 | `plugin-workflow` | （未声明） | — |
| 125 | `plugin-write` | （未声明） | — |
| 126 | `protein-sequence-msa` | （未声明） | — |
| 127 | `protein-sequence-similarity-search` | （未声明） | — |
| 128 | `pubmed-database` | （未声明） | — |
| 129 | `pyhealth` | （未声明） | — |
| 130 | `pymol` | （未声明） | — |
| 131 | `quickgo-database` | （未声明） | — |
| 132 | `reactome-database` | （未声明） | — |
| 133 | `string-database` | （未声明） | — |
| 134 | `tooluniverse-electron-microscopy` | （未声明） | — |
| 135 | `ucsc-conservation-and-tfbs` | （未声明） | — |
| 136 | `unibind-database` | （未声明） | — |
| 137 | `uniprot-database` | （未声明） | — |
| 138 | `uv` | （未声明） | — |
| 139 | `arbor` | MIT license | — |
| 140 | `autoskill` | MIT license | — |
| 141 | `bioimage-analysis` | MIT license | — |
| 142 | `cancer-genomics-analysis` | MIT license | — |
| 143 | `clinical-imaging` | MIT license | — |
| 144 | `consciousness-council` | MIT license | — |
| 145 | `deepchem` | MIT license | — |
| 146 | `dhdna-profiler` | MIT license | — |
| 147 | `diffdock` | MIT license | — |
| 148 | `esm` | MIT license | — |
| 149 | `experimental-design` | MIT license | — |
| 150 | `ginkgo-cloud-lab` | MIT license | — |
| 151 | `immunology-assays` | MIT license | — |
| 152 | `literature-review` | MIT license | — |
| 153 | `neuropixels-analysis` | MIT license | — |
| 154 | `pydeseq2` | MIT license | — |
| 155 | `research-grants` | MIT license | — |
| 156 | `research-lookup` | MIT license | — |
| 157 | `scientific-critical-thinking` | MIT license | — |
| 158 | `scientific-schematics` | MIT license | — |
| 159 | `scientific-slides` | MIT license | — |
| 160 | `stable-baselines3` | MIT license | — |
| 161 | `statistical-analysis` | MIT license | — |
| 162 | `statistical-power` | MIT license | — |
| 163 | `tiledbvcf` | MIT license | — |
| 164 | `torch-geometric` | MIT license | — |
| 165 | `vaex` | MIT license | — |
| 166 | `venue-templates` | MIT license | — |
| 167 | `zarr-python` | MIT license | — |
| 168 | `aeon` | BSD-3-Clause license | — |
| 169 | `anndata` | BSD-3-Clause license | — |
| 170 | `arboreto` | BSD-3-Clause license | — |
| 171 | `astropy` | BSD-3-Clause license | — |
| 172 | `dask` | BSD-3-Clause license | — |
| 173 | `flowio` | BSD-3-Clause license | — |
| 174 | `rdkit` | BSD-3-Clause license | — |
| 175 | `scikit-bio` | BSD-3-Clause license | — |
| 176 | `scikit-learn` | BSD-3-Clause license | — |
| 177 | `scvi-tools` | BSD-3-Clause license | — |
| 178 | `seaborn` | BSD-3-Clause license | — |
| 179 | `statsmodels` | BSD-3-Clause license | — |
| 180 | `umap-learn` | BSD-3-Clause license | — |
| 181 | `cirq` | Apache-2.0 license | — |
| 182 | `datamol` | Apache-2.0 license | — |
| 183 | `histolab` | Apache-2.0 license | — |
| 184 | `lamindb` | Apache-2.0 license | — |
| 185 | `medchem` | Apache-2.0 license | — |
| 186 | `molfeat` | Apache-2.0 license | — |
| 187 | `pennylane` | Apache-2.0 license | — |
| 188 | `pymoo` | Apache-2.0 license | — |
| 189 | `pytorch-lightning` | Apache-2.0 license | — |
| 190 | `timesfm-forecasting` | Apache-2.0 license | — |
| 191 | `torchdrug` | Apache-2.0 license | — |
| 192 | `transformers` | Apache-2.0 license | — |
| 193 | `liteparse` | Apache-2.0 | — |
| 194 | `markdown-mermaid-writing` | Apache-2.0 | — |
| 195 | `matchms` | Apache-2.0 | — |
| 196 | `modal` | Apache-2.0 | — |
| 197 | `nextflow` | Apache-2.0 | — |
| 198 | `polars-bio` | Apache-2.0 | — |
| 199 | `qiskit` | Apache-2.0 | — |
| 200 | `openpiv` | BSD-3-Clause | — |
| 201 | `scanpy` | BSD-3-Clause | — |
| 202 | `scvelo` | BSD-3-Clause | — |
| 203 | `citation-management` | MIT License | — |
| 204 | `geomaster` | MIT License | — |
| 205 | `pyzotero` | MIT License | — |
| 206 | `glycoengineering` | Unknown | — |
| 207 | `phylogenetics` | Unknown | — |
| 208 | `primekg` | Unknown | — |
| 209 | `pyopenms` | 3 clause BSD license | — |
| 210 | `networkx` | 3-clause BSD license | — |
| 211 | `pymc` | Apache License, Version 2.0 | — |
| 212 | `deeptools` | BSD license | — |
| 213 | `gget` | BSD-2-Clause license | — |
| 214 | `biopython` | Biopython License Agreement | — |
| 215 | `what-if-oracle` | CC BY-NC-SA 4.0 | — |
| 216 | `depmap` | CC-BY-4.0 | — |
| 217 | `cobrapy` | GPL-2.0 license | — |
| 218 | `etetoolkit` | GPL-3.0-or-later | — |
| 219 | `bioservices` | GPLv3 license | — |
| 220 | `deepspot-m` | PolyForm-Noncommercial-1.0.0 | — |
| 221 | `rowan` | Proprietary (API key required) | — |
| 222 | `imaging-data-commons` | This skill is provided under the MIT License. IDC data itself has individual licensing (mostly CC-BY, some CC-NC) that must be respected when using the data. | — |
| 223 | `bids` | https://creativecommons.org/licenses/by/4.0/ | — |
| 224 | `matplotlib` | https://github.com/matplotlib/matplotlib/tree/main/LICENSE | — |
| 225 | `polars` | https://github.com/pola-rs/polars/blob/main/LICENSE | — |
| 226 | `sympy` | https://github.com/sympy/sympy/blob/master/LICENSE | — |
