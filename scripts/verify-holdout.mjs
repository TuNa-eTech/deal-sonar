#!/usr/bin/env node
// Kiểm tra tính toàn vẹn của tập đánh giá riêng `docs/eval/holdout/` (issue #10).
//
//   node scripts/verify-holdout.mjs                       kiểm tra cấu trúc, ẩn danh, đếm mẫu, tách khỏi repo
//   node scripts/verify-holdout.mjs --summary             in bảng đếm mẫu dương/âm theo Radar (Markdown)
//   node scripts/verify-holdout.mjs --emit-blind-sheet    xuất phiếu gán nhãn mù cho người gán nhãn thứ hai
//   node scripts/verify-holdout.mjs --release             yêu cầu thêm bằng chứng gán nhãn độc lập (annotator-b + log)
//
// Không dùng phụ thuộc ngoài; cần Node >= 22.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(ROOT, 'docs', 'eval', 'holdout')
const args = new Set(process.argv.slice(2))
const errors = []
const fail = (msg) => errors.push(msg)

const ROLES = new Set(['end_user', 'peer', 'unknown'])
const FAKE_PHONE_NATIONAL = /^0\d{3}000\d{3}$/ // 09xx.000.xxx — dải giả định, không phải số thật
const FAKE_PHONE_E164 = /^\+84\d{3}000\d{3}$/
const PSEUDONYM = /^[a-z]{2}-\d{3}$/

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

function readJsonl(path) {
  const rows = []
  readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
    const t = line.trim()
    if (!t || t.startsWith('#')) return
    try {
      rows.push(JSON.parse(t))
    } catch (e) {
      fail(`${relative(ROOT, path)}:${i + 1}: JSONL không hợp lệ (${e.message})`)
    }
  })
  return rows
}

const norm = (s) => s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
  }
  return v
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))

// ---------------------------------------------------------------- ẩn danh
function checkAnonymity(label, s) {
  if (s.author_name !== null && !PSEUDONYM.test(s.author_name)) {
    fail(`${label}: author_name phải là bí danh dạng "ab-001" hoặc null, nhận ${JSON.stringify(s.author_name)}`)
  }
  if (!String(s.group_name).startsWith('Nhóm mẫu:')) fail(`${label}: group_name phải bắt đầu bằng "Nhóm mẫu:"`)
  if (/https?:\/\/|www\.|[\w.-]+@[\w-]+\.\w+|facebook\.com|fb\.com|zalo\.me/i.test(s.text)) {
    fail(`${label}: text chứa URL/email/liên kết tài khoản`)
  }
  for (const m of s.text.matchAll(/(?:\+84|\b0|\bo)\s?\d(?:[\s.\-]?\d){7,10}/gi)) {
    const digits = m[0].replace(/[\s.\-]/g, '').replace(/^o/i, '0').replace(/^\+84/, '0')
    if (!FAKE_PHONE_NATIONAL.test(digits)) fail(`${label}: số điện thoại không thuộc dải giả định: "${m[0]}"`)
  }
  if (/\b\d{12}\b/.test(s.text)) fail(`${label}: text chứa dãy 12 chữ số (nghi số CCCD)`)
  for (const [k, v] of Object.entries(s.expected_fields ?? {})) {
    if (typeof v === 'string' && v.startsWith('+') && !FAKE_PHONE_E164.test(v)) {
      fail(`${label}: expected_fields.${k} không thuộc dải số giả định: ${v}`)
    }
  }
}

// ---------------------------------------------------------------- nhãn trường
function checkFieldValue(label, def, v) {
  if (v === null) return
  const bad = (why) => fail(`${label}: trường "${def.key}" (${def.type}) ${why}: ${JSON.stringify(v)}`)
  switch (def.type) {
    case 'enum':
      if (!def.options?.includes(v)) bad('không nằm trong options')
      break
    case 'number':
      if (typeof v !== 'number') bad('phải là số')
      break
    case 'boolean':
      if (typeof v !== 'boolean') bad('phải là boolean')
      break
    case 'phone':
      if (typeof v !== 'string' || !/^\+84\d{9}$/.test(v)) bad('phải là E.164 +84…')
      break
    case 'money':
      if (typeof v?.min !== 'number' || typeof v?.max !== 'number' || v.currency !== 'VND') bad('phải có min, max, currency=VND')
      else if (v.min > v.max) bad('min > max')
      break
    case 'location':
      if (typeof v?.province !== 'string') bad('phải có province')
      break
    default:
      fail(`${label}: kiểu trường "${def.type}" chưa được verifier hỗ trợ`)
  }
}

// ---------------------------------------------------------------- nạp bộ
const manifest = readJson(join(DIR, 'manifest.json'))
const suites = manifest.radars.map((entry) => {
  const radar = readJson(join(DIR, entry.radar))
  const rows = readJsonl(join(DIR, entry.dataset))
  return { entry, radar, rows }
})

const countsOf = (rows) => {
  const c = { total: rows.length, positive: 0, negative: 0, peer: 0, end_user: 0, unknown: 0, role_unscored: 0 }
  for (const r of rows) {
    r.expected_match ? c.positive++ : c.negative++
    const role = r.expected_author_role
    if (role === 'peer') c.peer++
    else if (role === 'end_user') c.end_user++
    else if (role === 'unknown') c.unknown++
    else c.role_unscored++
  }
  return c
}

if (args.has('--summary')) {
  console.log('| Radar | Tổng | Dương (khớp) | Âm | Trong đó `peer` | `end_user` | `unknown` | Không chấm vai trò |')
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|')
  for (const { entry, rows } of suites) {
    const c = countsOf(rows)
    console.log(`| \`${entry.radar.replace('.radar.json', '')}\` | ${c.total} | ${c.positive} | ${c.negative} | ${c.peer} | ${c.end_user} | ${c.unknown} | ${c.role_unscored} |`)
  }
  process.exit(0)
}

if (args.has('--emit-blind-sheet')) {
  for (const { entry, radar, rows } of suites) {
    for (const r of rows.filter((x) => x.second_pass)) {
      console.log(JSON.stringify({
        radar: entry.radar.replace('.radar.json', ''),
        id: r.id,
        radar_description: radar.description,
        want_intent: radar.want_intent,
        group_name: r.group_name,
        text: r.text,
        expected_match: null,
        expected_author_role: null,
        expected_fields: null,
      }))
    }
  }
  process.exit(0)
}

// ---------------------------------------------------------------- kiểm tra từng bộ
const allTexts = new Map() // norm(text) -> "dataset:id"
for (const { entry, radar, rows } of suites) {
  const where = entry.dataset
  const defs = new Map(radar.fields.map((f) => [f.key, f]))
  const ids = new Set()
  const need = ['id', 'post_key', 'group_name', 'author_name', 'created_at_ms', 'text', 'expected_match',
    'expected_author_role', 'expected_fields', 'tags', 'conventions', 'second_pass', 'label_status']

  if (radar.id !== entry.radar_id) fail(`${entry.radar}: id "${radar.id}" ≠ manifest "${entry.radar_id}"`)
  for (const r of rows) {
    const label = `${where}#${r.id}`
    for (const k of need) if (!(k in r)) fail(`${label}: thiếu khóa "${k}"`)
    if (ids.has(r.id)) fail(`${label}: id trùng`)
    ids.add(r.id)
    if (!/^h[bg]-\d{3}$/.test(r.id)) fail(`${label}: id phải theo dạng hb-001 / hg-001 (tách khỏi bds-/xe-/dv-/ml- của golden)`)
    if (r.expected_author_role !== null && !ROLES.has(r.expected_author_role)) fail(`${label}: vai trò không hợp lệ`)
    if (r.expected_match && r.expected_author_role === 'peer') fail(`${label}: bài khớp không thể mang vai trò peer`)
    if (r.expected_match === true && r.expected_author_role !== 'end_user') fail(`${label}: bài khớp phải có vai trò end_user`)
    if (!r.expected_match && Object.keys(r.expected_fields).length) fail(`${label}: bài không khớp không gán nhãn trường`)
    if (r.expected_match) {
      for (const d of radar.fields) {
        if (!(d.key in r.expected_fields)) fail(`${label}: bài khớp phải gán nhãn rõ trường "${d.key}" (dùng null khi bài không nêu)`)
      }
    }
    for (const [k, v] of Object.entries(r.expected_fields)) {
      const d = defs.get(k)
      if (!d) fail(`${label}: trường "${k}" không có trong radar`)
      else checkFieldValue(label, d, v)
    }
    if (r.label_status !== 'draft_single_annotator' && r.label_status !== 'double_annotated_adjudicated') {
      fail(`${label}: label_status không hợp lệ`)
    }
    checkAnonymity(label, r)
    const key = norm(r.text)
    if (key.length < 20) fail(`${label}: text quá ngắn để kiểm tra rò rỉ`)
    if (!entry.shared_source) {
      if (allTexts.has(key)) fail(`${label}: trùng nguyên văn với ${allTexts.get(key)}`)
    }
    allTexts.set(key, `${where}#${r.id}`)
  }

  // đếm mẫu khớp manifest
  const got = countsOf(rows)
  for (const [k, v] of Object.entries(entry.counts)) {
    if (got[k] !== v) fail(`${where}: counts.${k} manifest=${v} nhưng dữ liệu=${got[k]}`)
  }

  // độ phủ nhóm khó
  const tagSet = new Set(rows.flatMap((r) => r.tags))
  for (const t of manifest.required_tags) if (!tagSet.has(t)) fail(`${where}: thiếu ca có thẻ "${t}"`)
  const pos = rows.filter((r) => r.expected_match)
  if (!pos.some((r) => Object.values(r.expected_fields).some((v) => v === null))) {
    fail(`${where}: cần ít nhất một ca khớp có trường thiếu dữ liệu (nhãn null)`)
  }

  // lấy mẫu gán nhãn lần hai
  const sp = rows.filter((r) => r.second_pass)
  if (sp.length / rows.length < manifest.min_second_pass_ratio) {
    fail(`${where}: second_pass ${sp.length}/${rows.length} < ${manifest.min_second_pass_ratio * 100}%`)
  }
  if (!sp.some((r) => r.expected_match) || !sp.some((r) => !r.expected_match)) {
    fail(`${where}: second_pass phải gồm cả mẫu dương lẫn âm`)
  }
}

// ---------------------------------------------------------------- cặp bài–Radar dùng chung nguồn
const groups = new Map()
for (const s of suites) {
  if (s.entry.shared_source) {
    if (!groups.has(s.entry.shared_source)) groups.set(s.entry.shared_source, [])
    groups.get(s.entry.shared_source).push(s)
  }
}
let flips = 0
for (const [name, members] of groups) {
  if (members.length < 2) fail(`nguồn dùng chung "${name}" cần ≥ 2 Radar`)
  const [base, ...rest] = members
  const byId = new Map(base.rows.map((r) => [r.id, r]))
  for (const other of rest) {
    if (other.rows.length !== base.rows.length) fail(`nguồn "${name}": số bài giữa ${base.entry.dataset} và ${other.entry.dataset} khác nhau`)
    for (const r of other.rows) {
      const b = byId.get(r.id)
      if (!b) { fail(`nguồn "${name}": ${r.id} có ở ${other.entry.dataset} nhưng không có ở ${base.entry.dataset}`); continue }
      for (const k of ['post_key', 'text', 'group_name', 'author_name', 'created_at_ms', 'second_pass']) {
        if (b[k] !== r[k]) fail(`nguồn "${name}": ${r.id} lệch khóa "${k}" giữa hai Radar`)
      }
      if (b.expected_match !== r.expected_match) flips++
      const flipTag = b.expected_match !== r.expected_match
      if (flipTag !== r.tags.includes('cross_radar_flip')) fail(`nguồn "${name}": ${r.id} thẻ cross_radar_flip không khớp nhãn thực tế`)
    }
  }
  const opposing = base.rows.filter((r) => r.expected_match).length > 0 &&
    rest.every((o) => o.rows.filter((r) => r.expected_match).length > 0)
  if (!opposing) fail(`nguồn "${name}": mỗi Radar cần có mẫu dương`)
}
if (flips < manifest.min_cross_radar_flips) fail(`số cặp bài đổi nhãn khớp giữa các Radar chung nguồn = ${flips} < ${manifest.min_cross_radar_flips}`)

const outOfLibrary = manifest.radars.filter((r) => r.kind === 'out_of_library')
if (!outOfLibrary.length) fail('manifest cần ít nhất một Radar kind="out_of_library"')

// ---------------------------------------------------------------- tách khỏi phần còn lại của repo
function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
      .toString('utf8').split('\0').filter(Boolean)
  } catch {
    return []
  }
}
const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|icns|woff2?|ttf|zip|gz|lock|wasm)$/i
const holdoutRel = relative(ROOT, DIR)
const needles = [...allTexts.keys()]
let scanned = 0
for (const f of trackedFiles()) {
  if (f.startsWith(holdoutRel + '/') || f.startsWith('docs/eval/reports/') || f.startsWith('.agents/') || f.startsWith('.hallmark/') || SKIP_EXT.test(f)) continue
  const abs = join(ROOT, f)
  if (!existsSync(abs) || statSync(abs).size > 4 * 1024 * 1024) continue
  const hay = norm(readFileSync(abs, 'utf8'))
  scanned++
  const jsonHay = hay.replace(/\\"/g, '"')
  for (const n of needles) {
    if (hay.includes(n) || jsonHay.includes(n)) fail(`${f}: chứa nguyên văn bài của holdout (${allTexts.get(n)}) — holdout không được dùng làm ví dụ/prompt/luật`)
  }
}

// ---------------------------------------------------------------- bằng chứng gán nhãn độc lập
const bPath = join(DIR, 'annotation', 'annotator-b.jsonl')
const logPath = join(DIR, 'annotation', 'agreement-log.jsonl')
let evidence = 'CHƯA CÓ — chưa có người gán nhãn thứ hai (annotation/annotator-b.jsonl vắng mặt)'
if (existsSync(bPath)) {
  const b = readJsonl(bPath)
  const log = existsSync(logPath) ? readJsonl(logPath) : []
  const logged = new Set(log.map((l) => `${l.radar}/${l.id}`))
  const lines = []
  for (const { entry, rows } of suites) {
    const stem = entry.radar.replace('.radar.json', '')
    const want = rows.filter((r) => r.second_pass)
    const got = new Map(b.filter((x) => x.radar === stem).map((x) => [x.id, x]))
    let agreeMatch = 0, agreeRole = 0, agreeFields = 0, nFields = 0, a1 = 0, b1 = 0
    for (const r of want) {
      const x = got.get(r.id)
      if (!x) { fail(`annotator-b: thiếu ${stem}/${r.id}`); continue }
      if (x.expected_match === r.expected_match) agreeMatch++
      else if (!logged.has(`${stem}/${r.id}`)) fail(`bất đồng khớp ${stem}/${r.id} chưa có dòng trong agreement-log.jsonl`)
      if ((x.expected_author_role ?? null) === (r.expected_author_role ?? null)) agreeRole++
      else if (!logged.has(`${stem}/${r.id}`)) fail(`bất đồng vai trò ${stem}/${r.id} chưa có dòng trong agreement-log.jsonl`)
      if (r.expected_match && x.expected_match) {
        nFields++
        if (same(x.expected_fields, r.expected_fields)) agreeFields++
        else if (!logged.has(`${stem}/${r.id}`)) fail(`bất đồng trường ${stem}/${r.id} chưa có dòng trong agreement-log.jsonl`)
      }
      if (r.expected_match) a1++
      if (x.expected_match) b1++
    }
    const n = want.length || 1
    const po = agreeMatch / n
    const pe = (a1 / n) * (b1 / n) + (1 - a1 / n) * (1 - b1 / n)
    const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe)
    if (kappa < manifest.min_kappa_match) fail(`${stem}: kappa khớp ${kappa.toFixed(2)} < ${manifest.min_kappa_match}`)
    lines.push(`${stem}: n=${want.length}, κ(khớp)=${kappa.toFixed(2)}, vai trò ${agreeRole}/${n}, trường ${agreeFields}/${nFields}`)
  }
  evidence = 'ĐÃ CÓ — ' + lines.join('; ')
} else if (args.has('--release')) {
  fail('--release: thiếu annotation/annotator-b.jsonl (cần người gán nhãn độc lập thứ hai cho ≥ 20% bài)')
}
if (args.has('--release') && suites.some((s) => s.rows.some((r) => r.second_pass && r.label_status !== 'double_annotated_adjudicated'))) {
  fail('--release: mọi bài second_pass phải có label_status="double_annotated_adjudicated"')
}

// ---------------------------------------------------------------- kết quả
if (errors.length) {
  console.error(`✗ holdout: ${errors.length} lỗi`)
  for (const e of errors.slice(0, 80)) console.error('  - ' + e)
  if (errors.length > 80) console.error(`  … và ${errors.length - 80} lỗi nữa`)
  process.exit(1)
}
const total = suites.reduce((n, s) => n + s.rows.length, 0)
const pairs = suites.reduce((n, s) => n + s.rows.length, 0)
console.log(`✓ holdout ${manifest.suite}: ${suites.length} Radar, ${pairs} cặp bài–Radar (${total} dòng nhãn), ${flips} cặp đổi nhãn khớp giữa Radar chung nguồn`)
for (const { entry, rows } of suites) {
  const c = countsOf(rows)
  console.log(`  ${entry.radar.replace('.radar.json', '')}: ${c.total} bài = ${c.positive} dương + ${c.negative} âm (peer ${c.peer})`)
}
console.log(`  đã đối chiếu nguyên văn với ${scanned} tệp được git theo dõi: không rò rỉ`)
console.log(`  bằng chứng gán nhãn độc lập: ${evidence}`)
