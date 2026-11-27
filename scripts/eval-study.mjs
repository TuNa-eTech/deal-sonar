#!/usr/bin/env node
// Nghiên cứu chất lượng bằng CLI AI thật trên tập holdout (issue #11).
//
//   node scripts/eval-study.mjs run --provider claude --model haiku [--repeat 3] [--batch-size 20] [--force]
//   node scripts/eval-study.mjs report [--dir docs/eval/reports/<study>] [--out docs/eval/reports/<study>/REPORT.md]
//   node scripts/eval-study.mjs plan   (in kế hoạch chạy và số lời gọi tối thiểu, không gọi AI)
//
// `run` gọi `target/debug/eval` (cargo build -p dealsonar-ai-bridge --bin eval) cho từng Radar của holdout và ghi
// `<dir>/<provider>__<model>/<radar>.json`. Tệp đã tồn tại được bỏ qua (tiết kiệm hạn mức) trừ khi có --force.
// `report` tổng hợp mọi tệp thành báo cáo Markdown: tử số/mẫu số, ngưỡng, ổn định, hạn mức, ví dụ lỗi.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOLDOUT = join(ROOT, 'docs', 'eval', 'holdout')
const DEFAULT_DIR = join(ROOT, 'docs', 'eval', 'reports', 'real-cli-holdout-v1')
const RADARS = ['bds-tim-nguoi-thue', 'bds-tim-chu-nha', 'gia-su-phu-huynh']

const [cmd = 'help', ...rest] = process.argv.slice(2)
const opt = {}
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith('--')) continue
  const k = rest[i].slice(2)
  opt[k] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true
}
const dir = resolve(opt.dir ?? DEFAULT_DIR)
const slug = (s) => String(s).replace(/[^a-zA-Z0-9._-]+/g, '-')

// ------------------------------------------------------------------ run / plan
function runStudy() {
  const provider = opt.provider
  if (!['claude', 'codex', 'agy'].includes(provider)) die('--provider claude|codex|agy là bắt buộc')
  const model = opt.model && opt.model !== true ? opt.model : null
  const repeat = Number(opt.repeat ?? 3)
  const batch = Number(opt['batch-size'] ?? 20)
  const bin = resolve(opt.bin ?? join(ROOT, 'target', 'debug', 'eval'))
  if (!existsSync(bin)) die(`không thấy ${bin}; chạy: cargo build -p dealsonar-ai-bridge --bin eval`)
  const sub = join(dir, `${provider}__${slug(model ?? 'cli-default')}${batch === 20 ? '' : `__b${batch}`}`)
  mkdirSync(sub, { recursive: true })
  for (const radar of RADARS) {
    const out = join(sub, `${radar}.json`)
    if (existsSync(out) && !opt.force) {
      console.log(`= bỏ qua ${relative(ROOT, out)} (đã có)`)
      continue
    }
    const args = [
      '--dataset', join(HOLDOUT, `${radar}.jsonl`),
      '--radar', join(HOLDOUT, `${radar}.radar.json`),
      '--provider', provider, '--batch-size', String(batch), '--repeat', String(repeat), '--out', out,
    ]
    if (model) args.push('--model', model)
    console.log(`> ${provider}${model ? ' ' + model : ''} ${radar} ×${repeat}`)
    const r = spawnSync(bin, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    writeFileSync(join(sub, `${radar}.log.txt`), (r.stdout ?? '') + (r.stderr ? `\n--- stderr ---\n${r.stderr}` : ''))
    if (r.stderr) process.stderr.write(r.stderr)
    if (r.status !== 0) {
      console.error(`✗ ${radar}: eval thoát mã ${r.status}`)
      process.exitCode = 1
    } else {
      console.log(`✓ ${relative(ROOT, out)}`)
    }
  }
}

function plan() {
  const rows = RADARS.map((r) => {
    const n = readFileSync(join(HOLDOUT, `${r}.jsonl`), 'utf8').split('\n').filter((l) => l.startsWith('{')).length
    return { r, n }
  })
  const repeat = Number(opt.repeat ?? 3)
  const batch = Number(opt['batch-size'] ?? 20)
  let calls = 0
  for (const { r, n } of rows) {
    const c = Math.ceil(n / batch) * repeat
    calls += c
    console.log(`${r}: ${n} bài, tối thiểu ${c} lời gọi (${repeat} lượt, lô ${batch})`)
  }
  console.log(`Cộng: ${calls} lời gọi cho mỗi cấu hình provider×model (chưa tính thử lại/chia đôi lô)`)
}

// ------------------------------------------------------------------ report
const pct = (x) => (x * 100).toFixed(2).replace('.', ',') + '%'
const frac = (c) => (c.denominator === 0 ? 'n/a (0/0)' : `${c.numerator}/${c.denominator} = ${pct(c.value)}`)
const trunc = (s, n = 150) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const j = (v) => (v === null || v === undefined ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v))

function load() {
  if (!existsSync(dir)) die(`không thấy thư mục báo cáo ${dir}`)
  const configs = []
  for (const sub of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    const reports = {}
    for (const radar of RADARS) {
      const f = join(dir, sub, `${radar}.json`)
      if (existsSync(f)) reports[radar] = JSON.parse(readFileSync(f, 'utf8'))
    }
    if (Object.keys(reports).length) configs.push({ name: sub, reports })
  }
  return configs
}

function pooled(report, name) {
  let num = 0, den = 0
  for (const run of report.run_checks) {
    const c = run.find((x) => x.name === name)
    if (c) { num += c.numerator; den += c.denominator }
  }
  return { numerator: num, denominator: den, value: den ? num / den : 1 }
}

function failingGates(report, scope) {
  // Một cổng chỉ "đạt" khi đạt ở MỌI lượt (kết luận thận trọng).
  const out = []
  const names = report.run_checks[0].filter((c) => c.scope === scope).map((c) => c.name)
  for (const n of names) {
    const per = report.run_checks.map((run) => run.find((x) => x.name === n))
    if (per.some((c) => !c.passed)) out.push({ name: n, runs: per })
  }
  return out
}


// Phân loại nguyên nhân lỗi trường để người đọc phân biệt lỗi thật với biến thể cách viết.
const fold = (v) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase()
const PROVINCE_ALIASES = {
  'ho chi minh': 'hcm', hcm: 'hcm', 'tp.hcm': 'hcm', tphcm: 'hcm', 'sai gon': 'hcm', sg: 'hcm', 'ho chi minh city': 'hcm',
  'ha noi': 'hn', hn: 'hn', hanoi: 'hn', 'da nang': 'dn',
}
function canonProvince(v) {
  const k = fold(v).replace(/^(thanh pho|tp\.?|tinh)\s*/u, '').replace(/\s+/g, ' ').trim()
  return PROVINCE_ALIASES[k] ?? PROVINCE_ALIASES[fold(v).trim()] ?? k
}
const LOC_NAMING = 'chỉ khác cách viết tên tỉnh/thành (vd "TP. Hồ Chí Minh" ↔ "TP.HCM")'
const LOC_OMITTED = 'AI chỉ trả quận/huyện, bỏ trống tỉnh/thành (nhãn có tỉnh/thành suy ra từ quận)'
function classifyFieldFailure(f) {
  const e = f.expected, a = f.actual
  if (a === null || a === undefined) return 'AI để trống (null) trong khi nhãn có giá trị'
  if (e === null || e === undefined) return 'AI điền giá trị trong khi nhãn là null (suy diễn thêm)'
  if (typeof e === 'object' && typeof a === 'object' && 'province' in e) {
    const dEq = (e.district ?? null) === null || String(e.district).toLowerCase() === String(a.district ?? '').toLowerCase()
    const pEq = canonProvince(e.province) === canonProvince(a.province)
    if (dEq && (a.province === null || a.province === undefined) && e.province) return LOC_OMITTED
    if (dEq && pEq) return LOC_NAMING
    if (!pEq) return 'sai tỉnh/thành'
    return 'sai quận/huyện'
  }
  return 'sai giá trị'
}

function renderReport(configs) {
  const L = []
  const any = configs[0].reports[Object.keys(configs[0].reports)[0]]
  L.push('# Báo cáo chất lượng bằng CLI AI thật trên tập holdout-v1')
  L.push('')
  L.push('Issue [#11](https://github.com/TuNa-eTech/deal-sonar/issues/11), phụ thuộc [#10](https://github.com/TuNa-eTech/deal-sonar/issues/10). Sinh bằng `node scripts/eval-study.mjs report`.')
  L.push('')
  L.push('> [!WARNING]')
  L.push('> **Đây là số đo trên nhãn nháp một người gán (`draft_single_annotator`) và bài dựng lại (synthetic), chưa phải bài từ nhóm thật.** Kết quả đạt ngưỡng ở đây **chưa đủ** để tuyên bố một nhu cầu được hỗ trợ; cần hoàn tất bằng chứng còn thiếu ở [holdout README §6](../../holdout/README.md) (người gán nhãn độc lập thứ hai, mẫu thật đã ẩn danh).')
  L.push('')
  L.push('## 1. Cấu hình đo')
  L.push('')
  L.push('| Cấu hình (thư mục) | Provider | Phiên bản CLI | Model báo cáo bởi CLI | Model chỉ định | Lô | Lượt hoàn thành/yêu cầu theo Radar |')
  L.push('|---|---|---|---|---|---:|---:|')
  for (const c of configs) {
    const r = Object.values(c.reports)[0]
    const models = [...new Set(Object.values(c.reports).flatMap((x) => x.runs.flatMap((u) => u.models)))]
    L.push(`| \`${c.name}\` | ${r.provider} | ${r.cli_version ?? 'n/a'} | ${models.join(', ') || '(CLI không báo cáo)'} | ${r.model_override ?? '(mặc định của CLI)'} | ${r.batch_size} | ${Object.values(c.reports).map((x) => `${x.runs.length}/${x.repeat}`).join(', ')} |`)
  }
  L.push('')
  L.push('| Radar | `radar_version_id` | Tập bài | Dấu vân tay (FNV-1a 64) | Số bài |')
  L.push('|---|---|---|---|---:|')
  for (const radar of RADARS) {
    const r = configs.map((c) => c.reports[radar]).find(Boolean)
    if (r) L.push(`| \`${radar}\` | \`${r.radar_version_id}\` | \`${relative(ROOT, resolve(ROOT, r.dataset))}\` | \`${r.dataset_fingerprint_fnv1a64}\` | ${r.dataset_posts} |`)
  }
  L.push('')
  L.push('Ngưỡng của issue: **precision ≥ 85%**, **recall ≥ 90%**, **mỗi trường bắt buộc ≥ 90%**. Ngưỡng H2 còn lại (peer ≥ 75%, trường tuỳ chọn ≥ 80%, bịa `raw` ≤ 1%, ổn định ≤ 3%) báo cáo ở mục 4.')
  L.push('Một cổng chỉ ghi **ĐẠT** khi đạt ở **mọi** lượt lặp; cột "gộp" cộng tử số và mẫu số của mọi lượt.')
  L.push('')

  const verdicts = []
  let idx = 2
  L.push(`## ${idx++}. Kết quả theo Radar (ba cổng của issue)`)
  for (const c of configs) {
    for (const radar of RADARS) {
      const rep = c.reports[radar]
      if (!rep) continue
      const gates = rep.run_checks[0].filter((x) => x.scope === 'issue_gate')
      const failing = failingGates(rep, 'issue_gate')
      L.push('')
      L.push(`### \`${c.name}\` × \`${radar}\``)
      L.push('')
      L.push('| Phép đo | Ngưỡng | ' + rep.run_checks.map((_, i) => `Lượt ${i + 1}`).join(' | ') + ' | Gộp | Kết luận |')
      L.push('|---|---:|' + rep.run_checks.map(() => '---|').join('') + '---|---|')
      for (const g of gates) {
        const per = rep.run_checks.map((run) => run.find((x) => x.name === g.name))
        const ok = per.every((x) => x.passed)
        L.push(`| ${g.name} | ≥ ${Math.round(g.threshold * 100)}% | ${per.map(frac).join(' | ')} | ${frac(pooled(rep, g.name))} | ${ok ? 'ĐẠT' : '**CHƯA ĐẠT**'} |`)
      }
      verdicts.push({ config: c.name, radar, failing: failing.map((f) => f.name), h2: failingGates(rep, 'h2_gate').map((f) => f.name), stability: rep.stability, incomplete: rep.runs.length < rep.repeat ? `${rep.runs.length}/${rep.repeat} lượt` : null })
    }
    for (const radar of RADARS.filter((r) => !c.reports[r])) {
      verdicts.push({ config: c.name, radar, failing: [], h2: [], stability: { passed: null }, missing: true })
    }
  }

  L.push('')
  L.push(`## ${idx++}. Ổn định qua các lượt lặp`)
  L.push('')
  L.push('Ngưỡng: tỉ lệ bài đổi quyết định khớp giữa các lượt ≤ 3% ([validation plan §3.2](../../../delivery/02-validation-plan.md)).')
  L.push('')
  L.push('| Cấu hình | Radar | Số lượt | Bài đổi quyết định | Tỉ lệ | Kết luận | Bài đổi |')
  L.push('|---|---|---:|---:|---:|---|---|')
  for (const c of configs) {
    for (const radar of RADARS) {
      const s = c.reports[radar]?.stability
      if (!s) continue
      const v = s.passed === null ? 'chưa đo' : s.passed ? 'ĐẠT' : '**CHƯA ĐẠT**'
      L.push(`| \`${c.name}\` | \`${radar}\` | ${s.runs} | ${s.posts_changed}/${s.posts} | ${pct(s.rate)} | ${v} | ${s.changed_post_ids.map((x) => `\`${x}\``).join(', ') || '—'} |`)
    }
  }

  L.push('')
  L.push(`## ${idx++}. Các ngưỡng H2 còn lại (gộp mọi lượt)`)
  L.push('')
  L.push('| Cấu hình | Radar | Peer precision | Peer recall | Trường tuỳ chọn kém nhất | Bịa `raw` |')
  L.push('|---|---|---|---|---|---|')
  for (const c of configs) {
    for (const radar of RADARS) {
      const rep = c.reports[radar]
      if (!rep) continue
      const opts = rep.run_checks[0].filter((x) => x.scope === 'h2_gate' && x.name.startsWith('field:')).map((x) => ({ name: x.name, ...pooled(rep, x.name) }))
      opts.sort((a, b) => a.value - b.value)
      const worst = opts[0]
      const raw = rep.runs.reduce((a, r) => ({ n: a.n + r.hallucinated_raw_count, d: a.d + r.total_non_null_extractions }), { n: 0, d: 0 })
      const pp = pooled(rep, 'peer_precision'), pr = pooled(rep, 'peer_recall')
      L.push(`| \`${c.name}\` | \`${radar}\` | ${frac({ ...pp })}${pp.value < 0.75 ? ' ⚠' : ''} | ${frac({ ...pr })}${pr.value < 0.75 ? ' ⚠' : ''} | ${worst ? `${worst.name} ${frac(worst)}${worst.value < 0.8 ? ' ⚠' : ''}` : 'n/a'} | ${raw.n}/${raw.d} = ${pct(raw.d ? raw.n / raw.d : 0)}${raw.d && raw.n / raw.d > 0.01 ? ' ⚠' : ''} |`)
    }
  }

  L.push('')
  L.push(`## ${idx++}. Số lần gọi và hạn mức tiêu thụ`)
  L.push('')
  L.push('Số liệu do CLI báo cáo trong phong bì JSON. `cost_usd` chỉ có khi CLI trả về; với gói thuê bao đó là mức quy đổi, không phải tiền thật phải trả. n/a = CLI không báo cáo.')
  L.push('')
  L.push('| Cấu hình | Radar | Lời gọi | Lời gọi lỗi | Chia đôi lô | Token vào | Token ra | Chi phí quy đổi (USD) | Thời gian CLI |')
  L.push('|---|---|---:|---:|---:|---:|---:|---:|---:|')
  const totals = {}
  for (const c of configs) {
    totals[c.name] = { calls: 0, failed: 0, bis: 0, tin: 0, tout: 0, cost: 0, hasCost: false, ms: 0 }
    for (const radar of RADARS) {
      const rep = c.reports[radar]
      if (!rep) continue
      const a = rep.runs.reduce((s, r) => ({
        calls: s.calls + r.total_calls, failed: s.failed + r.failed_calls, bis: s.bis + r.bisection_count,
        tin: s.tin + r.total_input_tokens, tout: s.tout + r.total_output_tokens,
        cost: s.cost + (r.total_cost_usd ?? 0), hasCost: s.hasCost || r.total_cost_usd != null, ms: s.ms + r.total_duration_ms,
      }), { calls: 0, failed: 0, bis: 0, tin: 0, tout: 0, cost: 0, hasCost: false, ms: 0 })
      const t = totals[c.name]
      for (const k of ['calls', 'failed', 'bis', 'tin', 'tout', 'cost', 'ms']) t[k] += a[k]
      t.hasCost ||= a.hasCost
      L.push(`| \`${c.name}\` | \`${radar}\` | ${a.calls} | ${a.failed} | ${a.bis} | ${a.tin} | ${a.tout} | ${a.hasCost ? a.cost.toFixed(4) : 'n/a'} | ${(a.ms / 60000).toFixed(1)} phút |`)
    }
    const t = totals[c.name]
    L.push(`| **\`${c.name}\` cộng** | | **${t.calls}** | **${t.failed}** | **${t.bis}** | **${t.tin}** | **${t.tout}** | **${t.hasCost ? t.cost.toFixed(4) : 'n/a'}** | **${(t.ms / 60000).toFixed(1)} phút** |`)
  }

  L.push('')
  L.push(`## ${idx++}. Ví dụ lỗi đã ẩn danh`)
  L.push('')
  L.push('Văn bản lấy nguyên từ tập holdout (đã ẩn danh: bí danh, số điện thoại giả dải `09xx.000.xxx`). Lỗi được nhóm theo bài; "lặp" là số lượt (trên tổng) mà cùng lỗi xuất hiện.')
  const kindLabel = { false_positive: 'báo khớp nhầm', false_negative: 'bỏ sót bài khớp', peer_missed: 'không nhận ra người cùng nghề', peer_false_alarm: 'gán nhầm là người cùng nghề', field_mismatch: 'trích sai trường', hallucinated_raw: 'bịa `raw`', ai_failed: 'lời gọi AI thất bại' }
  for (const c of configs) {
    for (const radar of RADARS) {
      const rep = c.reports[radar]
      if (!rep) continue
      const seen = new Map()
      rep.runs.forEach((run) => {
        const inRun = new Set()
        for (const f of run.failures) {
          const key = `${f.post_id}|${f.kind}|${f.field ?? ''}`
          if (!seen.has(key)) seen.set(key, { f, runs: 0 })
          if (!inRun.has(key)) { seen.get(key).runs++; inRun.add(key) }
        }
      })
      const list = [...seen.values()].sort((a, b) => b.runs - a.runs || a.f.post_id.localeCompare(b.f.post_id))
      L.push('')
      L.push(`### \`${c.name}\` × \`${radar}\` — ${list.length} lỗi khác nhau`)
      if (!list.length) { L.push(''); L.push('Không có lỗi nào ở mọi lượt.'); continue }
      const byKind = {}
      for (const e of list) byKind[e.f.kind] = (byKind[e.f.kind] ?? 0) + 1
      L.push('')
      L.push('Theo loại: ' + Object.entries(byKind).map(([k, n]) => `${kindLabel[k] ?? k} ${n}`).join('; ') + '.')
      L.push('')
      L.push('| Bài | Loại | Trường | Kỳ vọng | AI trả về | Lặp | Văn bản (rút gọn) | Lý do AI nêu |')
      L.push('|---|---|---|---|---|---:|---|---|')
      for (const { f, runs } of list.slice(0, Number(opt.examples ?? 12))) {
        const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ')
        L.push(`| \`${f.post_id}\` | ${kindLabel[f.kind] ?? f.kind} | ${f.field ?? '—'} | \`${esc(j(f.expected))}\` | \`${esc(j(f.actual))}\` | ${runs}/${rep.runs.length} | ${esc(trunc(f.text))} | ${esc(trunc(f.ai_reason, 110))} |`)
      }
    }
  }

  L.push('')
  L.push(`## ${idx++}. Nguyên nhân các lỗi trường bắt buộc`)
  L.push('')
  L.push('Phân loại mọi lỗi `field_mismatch` của trường bắt buộc (gộp mọi lượt). Cột "nếu bỏ qua lỗi tên/thiếu tỉnh" chỉ để chẩn đoán: số chính thức vẫn là so khớp chuỗi sau chuẩn hoá chữ thường như quy định ở [docs/eval/README.md §2](../../README.md); **không** dùng để tuyên bố đạt.')
  L.push('')
  L.push('| Cấu hình | Radar | Trường | Đúng gộp | Nguyên nhân (số lần) | Nếu bỏ qua lỗi tên/thiếu tỉnh |')
  L.push('|---|---|---|---:|---|---:|')
  for (const c of configs) {
    for (const radar of RADARS) {
      const rep = c.reports[radar]
      if (!rep) continue
      for (const g of rep.run_checks[0].filter((x) => x.scope === 'issue_gate' && x.name.startsWith('field:'))) {
        const key = g.name.slice(6)
        const pl = pooled(rep, g.name)
        if (pl.denominator === 0 || pl.value >= 0.9 && rep.run_checks.every((r) => r.find((x) => x.name === g.name).passed)) continue
        const fs = rep.runs.flatMap((r) => r.failures.filter((f) => f.kind === 'field_mismatch' && f.field === key))
        const by = {}
        for (const f of fs) { const k = classifyFieldFailure(f); by[k] = (by[k] ?? 0) + 1 }
        const naming = (by[LOC_NAMING] ?? 0) + (by[LOC_OMITTED] ?? 0)
        const adj = { numerator: pl.numerator + naming, denominator: pl.denominator }
        L.push(`| \`${c.name}\` | \`${radar}\` | ${key} | ${frac(pl)} | ${Object.entries(by).map(([k, n]) => `${k}: ${n}`).join('; ')} | ${frac({ ...adj, value: adj.numerator / adj.denominator })} |`)
      }
    }
  }

  L.push('')
  L.push(`## ${idx++}. Kết luận và việc khắc phục`)
  L.push('')
  const bad = verdicts.filter((v) => v.missing || v.incomplete || v.failing.length || v.h2.length || v.stability.passed === false)
  if (!bad.length) {
    L.push('Mọi cấu hình × Radar đo được đều đạt ba cổng của issue, các ngưỡng H2 còn lại và ngưỡng ổn định **trên holdout nháp**. Điều đó **chưa** cho phép tuyên bố "được hỗ trợ": còn thiếu nhãn độc lập và mẫu thật (xem cảnh báo đầu báo cáo).')
  } else {
    L.push('**Không tuyên bố các cấu hình × Radar sau là được hỗ trợ.** Mỗi dòng cần một việc khắc phục được mở và xử lý trước khi tuyên bố (nội dung sẵn ở [REMEDIATION.md](./REMEDIATION.md)). `agy` chưa đo được (mục 9). Một cấu hình đạt mọi cổng đã đo vẫn chưa được tuyên bố là hỗ trợ vì cảnh báo nhãn nháp ở đầu báo cáo.')
    L.push('')
    L.push('| Cấu hình | Radar | Cổng của issue hụt | Cổng H2 khác hụt | Ổn định | Ghi chú |')
    L.push('|---|---|---|---|---|---|')
    for (const v of bad) {
      const st = v.missing ? '—' : v.stability.passed === false ? `CHƯA ĐẠT (${pct(v.stability.rate)})` : v.stability.passed === null ? 'chưa đo' : 'ĐẠT'
      L.push(`| \`${v.config}\` | \`${v.radar}\` | ${v.failing.join(', ') || '—'} | ${v.h2.join(', ') || '—'} | ${st} | ${v.missing ? '**chưa đo** (xem mục 9)' : v.incomplete ? `chỉ ${v.incomplete}` : ''} |`)
    }
  }
  const notes = join(dir, 'NOTES.md')
  if (existsSync(notes)) {
    L.push('')
    L.push(`## ${idx++}. Ghi chú vận hành và cấu hình không đo được`)
    L.push('')
    L.push(readFileSync(notes, 'utf8').trim())
  }
  L.push('')
  return L.join('\n')
}

function report() {
  const configs = load()
  if (!configs.length) die(`không có báo cáo nào trong ${dir}`)
  const md = renderReport(configs)
  const out = resolve(opt.out ?? join(dir, 'REPORT.md'))
  writeFileSync(out, md)
  console.log(`✓ ${relative(ROOT, out)} (${md.split('\n').length} dòng, ${configs.length} cấu hình)`)
}

function die(msg) {
  console.error('✗ ' + msg)
  process.exit(2)
}

if (cmd === 'run') runStudy()
else if (cmd === 'report') report()
else if (cmd === 'plan') plan()
else {
  console.log('Dùng: eval-study.mjs run --provider claude|codex|agy [--model m] [--repeat 3] [--batch-size 20] [--force] | report | plan')
}
