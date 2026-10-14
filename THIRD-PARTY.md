# 第三方技能来源与许可清单（THIRD-PARTY）

本仓库的 `LICENSE`（MIT）只覆盖插件本身的代码。`data/skill-pack.json.gz` 里打包的
195 个技能是**第三方作品**，各自适用其上游许可，**不适用 MIT**。

清单由 `data/skill-pack.json.gz` 里每个技能的 frontmatter 直接抽取（不手工转写）。
「来源」列取自 frontmatter 的 `source` / `repo`；没写就从缺。

## 许可分布

| 许可 | 技能数 |
| --- | --- |
| MIT | 74 |
| （未声明） | 37 |
| MIT license | 25 |
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
| `rowan` | 见右 | Proprietary（需要 API key）—— 商用/再分发前请先取得授权 |
| `what-if-oracle` | 见右 | CC BY-NC-SA 4.0 —— 非商业；再分发需署名并以相同方式共享 |
| `deepspot-m` | 见右 | PolyForm Noncommercial 1.0.0 —— 仅限非商业用途 |
| `etetoolkit` | GPL-3.0-or-later | 强著佐权：再分发该技能（或其衍生）时须一并提供源代码 |

**连许可字段都没写的技能**：上游没声明许可，不等于授权再分发。这里如实标「（未声明）」。
如果你是这些技能的作者、或希望某个技能从本包中移除，开 issue 即可，会尽快处理。

## 逐条清单

| # | 技能 | 许可 | 来源 |
| --- | --- | --- | --- |
| 1 | `pyopenms` | 3 clause BSD license | — |
| 2 | `networkx` | 3-clause BSD license | — |
| 3 | `pymc` | Apache License, Version 2.0 | — |
| 4 | `liteparse` | Apache-2.0 | — |
| 5 | `markdown-mermaid-writing` | Apache-2.0 | — |
| 6 | `matchms` | Apache-2.0 | — |
| 7 | `modal` | Apache-2.0 | — |
| 8 | `nextflow` | Apache-2.0 | — |
| 9 | `polars-bio` | Apache-2.0 | — |
| 10 | `qiskit` | Apache-2.0 | — |
| 11 | `cirq` | Apache-2.0 license | — |
| 12 | `datamol` | Apache-2.0 license | — |
| 13 | `histolab` | Apache-2.0 license | — |
| 14 | `lamindb` | Apache-2.0 license | — |
| 15 | `medchem` | Apache-2.0 license | — |
| 16 | `molfeat` | Apache-2.0 license | — |
| 17 | `pennylane` | Apache-2.0 license | — |
| 18 | `pymoo` | Apache-2.0 license | — |
| 19 | `pytorch-lightning` | Apache-2.0 license | — |
| 20 | `timesfm-forecasting` | Apache-2.0 license | — |
| 21 | `torchdrug` | Apache-2.0 license | — |
| 22 | `transformers` | Apache-2.0 license | — |
| 23 | `deeptools` | BSD license | — |
| 24 | `gget` | BSD-2-Clause license | — |
| 25 | `openpiv` | BSD-3-Clause | — |
| 26 | `scanpy` | BSD-3-Clause | — |
| 27 | `scvelo` | BSD-3-Clause | — |
| 28 | `aeon` | BSD-3-Clause license | — |
| 29 | `anndata` | BSD-3-Clause license | — |
| 30 | `arboreto` | BSD-3-Clause license | — |
| 31 | `astropy` | BSD-3-Clause license | — |
| 32 | `dask` | BSD-3-Clause license | — |
| 33 | `flowio` | BSD-3-Clause license | — |
| 34 | `rdkit` | BSD-3-Clause license | — |
| 35 | `scikit-bio` | BSD-3-Clause license | — |
| 36 | `scikit-learn` | BSD-3-Clause license | — |
| 37 | `scvi-tools` | BSD-3-Clause license | — |
| 38 | `seaborn` | BSD-3-Clause license | — |
| 39 | `statsmodels` | BSD-3-Clause license | — |
| 40 | `umap-learn` | BSD-3-Clause license | — |
| 41 | `biopython` | Biopython License Agreement | — |
| 42 | `what-if-oracle` | CC BY-NC-SA 4.0 | — |
| 43 | `depmap` | CC-BY-4.0 | — |
| 44 | `cobrapy` | GPL-2.0 license | — |
| 45 | `etetoolkit` | GPL-3.0-or-later | — |
| 46 | `bioservices` | GPLv3 license | — |
| 47 | `adaptyv` | MIT | — |
| 48 | `alphagenome` | MIT | — |
| 49 | `analytical-method-validation` | MIT | — |
| 50 | `benchling-integration` | MIT | — |
| 51 | `bgpt-paper-search` | MIT | — |
| 52 | `bulk-rnaseq` | MIT | — |
| 53 | `cellxgene-census` | MIT | — |
| 54 | `clinical-decision-support` | MIT | — |
| 55 | `clinical-reports` | MIT | — |
| 56 | `database-lookup` | MIT | — |
| 57 | `datalad` | MIT | — |
| 58 | `dnanexus-integration` | MIT | — |
| 59 | `exa-search` | MIT | — |
| 60 | `exploratory-data-analysis` | MIT | — |
| 61 | `fluidsim` | MIT | — |
| 62 | `folklore-variant-evidence` | MIT | — |
| 63 | `generate-image` | MIT | — |
| 64 | `geniml` | MIT | — |
| 65 | `genomic-coordinates` | MIT | — |
| 66 | `genomic-intelligence` | MIT | — |
| 67 | `geopandas` | MIT | — |
| 68 | `get-available-resources` | MIT | — |
| 69 | `gtars` | MIT | — |
| 70 | `hypogenic` | MIT | — |
| 71 | `hypothesis-generation` | MIT | — |
| 72 | `iso-standards-readiness` | MIT | — |
| 73 | `lab-hardware-cad` | MIT | — |
| 74 | `labarchive-integration` | MIT | — |
| 75 | `latchbio-integration` | MIT | — |
| 76 | `market-research-reports` | MIT | — |
| 77 | `markitdown` | MIT | — |
| 78 | `matlab` | MIT | — |
| 79 | `molecular-dynamics` | MIT | — |
| 80 | `ncats-arax` | MIT | — |
| 81 | `neurokit2` | MIT | — |
| 82 | `omero-integration` | MIT | — |
| 83 | `onekgpd` | MIT | — |
| 84 | `ontology-term-resolution` | MIT | — |
| 85 | `open-notebook` | MIT | — |
| 86 | `opentrons-integration` | MIT | — |
| 87 | `optimize-for-gpu` | MIT | — |
| 88 | `pacsomatic` | MIT | — |
| 89 | `paper-lookup` | MIT | — |
| 90 | `paperclip` | MIT | — |
| 91 | `paperzilla` | MIT | — |
| 92 | `parallel-web` | MIT | — |
| 93 | `pathml` | MIT | — |
| 94 | `pathogen-variant-surveillance` | MIT | — |
| 95 | `pathway-enrichment` | MIT | — |
| 96 | `peer-review` | MIT | — |
| 97 | `pi-agent` | MIT | — |
| 98 | `pkpd-modeling` | MIT | — |
| 99 | `pptx-posters` | MIT | — |
| 100 | `protocolsio-integration` | MIT | — |
| 101 | `pufferlib` | MIT | — |
| 102 | `pydicom` | MIT | — |
| 103 | `pylabrobot` | MIT | — |
| 104 | `pymatgen` | MIT | — |
| 105 | `pysam` | MIT | — |
| 106 | `pytdc` | MIT | — |
| 107 | `qutip` | MIT | — |
| 108 | `relsa-severity-assessment` | MIT | — |
| 109 | `scholar-evaluation` | MIT | — |
| 110 | `scientific-brainstorming` | MIT | — |
| 111 | `scientific-visualization` | MIT | — |
| 112 | `scientific-writing` | MIT | — |
| 113 | `scikit-survival` | MIT | — |
| 114 | `shap` | MIT | — |
| 115 | `simpy` | MIT | — |
| 116 | `tamarind` | MIT | — |
| 117 | `treatment-plans` | MIT | — |
| 118 | `uncertainty-and-units` | MIT | — |
| 119 | `usfiscaldata` | MIT | — |
| 120 | `waypoint-bio` | MIT | — |
| 121 | `citation-management` | MIT License | — |
| 122 | `geomaster` | MIT License | — |
| 123 | `pyzotero` | MIT License | — |
| 124 | `arbor` | MIT license | — |
| 125 | `autoskill` | MIT license | — |
| 126 | `consciousness-council` | MIT license | — |
| 127 | `deepchem` | MIT license | — |
| 128 | `dhdna-profiler` | MIT license | — |
| 129 | `diffdock` | MIT license | — |
| 130 | `esm` | MIT license | — |
| 131 | `experimental-design` | MIT license | — |
| 132 | `ginkgo-cloud-lab` | MIT license | — |
| 133 | `literature-review` | MIT license | — |
| 134 | `neuropixels-analysis` | MIT license | — |
| 135 | `pydeseq2` | MIT license | — |
| 136 | `research-grants` | MIT license | — |
| 137 | `research-lookup` | MIT license | — |
| 138 | `scientific-critical-thinking` | MIT license | — |
| 139 | `scientific-schematics` | MIT license | — |
| 140 | `scientific-slides` | MIT license | — |
| 141 | `stable-baselines3` | MIT license | — |
| 142 | `statistical-analysis` | MIT license | — |
| 143 | `statistical-power` | MIT license | — |
| 144 | `tiledbvcf` | MIT license | — |
| 145 | `torch-geometric` | MIT license | — |
| 146 | `vaex` | MIT license | — |
| 147 | `venue-templates` | MIT license | — |
| 148 | `zarr-python` | MIT license | — |
| 149 | `deepspot-m` | PolyForm-Noncommercial-1.0.0 | — |
| 150 | `rowan` | Proprietary (API key required) | — |
| 151 | `imaging-data-commons` | This skill is provided under the MIT License. IDC data itself has individual licensing (mostly CC-BY, some CC-NC) that must be respected when using the data. | — |
| 152 | `glycoengineering` | Unknown | — |
| 153 | `phylogenetics` | Unknown | — |
| 154 | `primekg` | Unknown | — |
| 155 | `bids` | https://creativecommons.org/licenses/by/4.0/ | — |
| 156 | `matplotlib` | https://github.com/matplotlib/matplotlib/tree/main/LICENSE | — |
| 157 | `polars` | https://github.com/pola-rs/polars/blob/main/LICENSE | — |
| 158 | `sympy` | https://github.com/sympy/sympy/blob/master/LICENSE | — |
| 159 | `alphafold-database-fetch-and-analyze` | （未声明） | — |
| 160 | `alphagenome-single-variant-analysis` | （未声明） | — |
| 161 | `alphagenome-variant-impact-score` | （未声明） | — |
| 162 | `clinvar-database` | （未声明） | — |
| 163 | `dbsnp-database` | （未声明） | — |
| 164 | `encode-ccres-database` | （未声明） | — |
| 165 | `ensembl-database` | （未声明） | — |
| 166 | `foldseek-structural-search` | （未声明） | — |
| 167 | `gnomad-database` | （未声明） | — |
| 168 | `hugging-science` | （未声明） | — |
| 169 | `human-protein-atlas-database` | （未声明） | — |
| 170 | `infographics` | （未声明） | — |
| 171 | `interpro-database` | （未声明） | — |
| 172 | `jaspar-database` | （未声明） | — |
| 173 | `latex-posters` | （未声明） | — |
| 174 | `literature-search-europepmc` | （未声明） | — |
| 175 | `medical-evidence-appraisal` | （未声明） | — |
| 176 | `medical-language-polish` | （未声明） | — |
| 177 | `medical-literature-retrieval` | （未声明） | — |
| 178 | `medical-paper-reading` | （未声明） | — |
| 179 | `medical-paper-writing` | （未声明） | — |
| 180 | `medical-reference-format` | （未声明） | — |
| 181 | `nature-ppt` | （未声明） | — |
| 182 | `ncbi-sequence-fetch` | （未声明） | — |
| 183 | `pdb-database` | （未声明） | — |
| 184 | `protein-sequence-msa` | （未声明） | — |
| 185 | `protein-sequence-similarity-search` | （未声明） | — |
| 186 | `pubmed-database` | （未声明） | — |
| 187 | `pyhealth` | （未声明） | — |
| 188 | `pymol` | （未声明） | — |
| 189 | `quickgo-database` | （未声明） | — |
| 190 | `reactome-database` | （未声明） | — |
| 191 | `string-database` | （未声明） | — |
| 192 | `ucsc-conservation-and-tfbs` | （未声明） | — |
| 193 | `unibind-database` | （未声明） | — |
| 194 | `uniprot-database` | （未声明） | — |
| 195 | `uv` | （未声明） | — |
