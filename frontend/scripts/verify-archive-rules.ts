import { archiveHistoryVersions, evaluateArchiveAction, listAvailableActions, applyArchiveAction, VERSION_FIELD } from '../src/data/archive-rules'
import { exportEntries, resetModule, runAction } from '../src/api/local-service'
import type { EntryRow } from '../src/data/types'

// local-store 惰性读取 window，这里先打一个内存 localStorage 桩。
const memory = new Map<string, string>()
;(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => (memory.has(k) ? memory.get(k)! : null),
    setItem: (k: string, v: string) => void memory.set(k, v),
  },
}

let passed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (!cond) {
    console.error('FAIL:', name, extra ?? '')
    process.exitCode = 1
  } else {
    passed += 1
  }
}
function row(id: number, patch: Partial<EntryRow> = {}): EntryRow {
  return { id, status: '待归档', pending: true, abnormal: false,
    '档案编号': `T-${id}`, '设施类别': '未知类型占位', '所属区域': 'A',
    '竣工日期': '2026-09-01', '设计图纸': '图', '承建企业': '企业', ...patch }
}
function runAll(row: EntryRow) {
  return listAvailableActions(row).map((a) => applyArchiveAction(row, a).ok)
}
function ok(row: EntryRow, action: string): EntryRow {
  const out = applyArchiveAction(row, action)
  if (!out.ok) throw new Error(`expected ok: ${action} -> ${out.message}`)
  return out.row
}

// 1. 待归档：可归档/可作废，不可更新；未归档无历史版本
{
  const r = row(1)
  check('待归档动作集', JSON.stringify(listAvailableActions(r)) === JSON.stringify(['提交归档', '作废档案']), listAvailableActions(r))
  check('未归档更新拒绝', !applyArchiveAction(r, '更新档案').ok)
  check('未归档无历史版本', archiveHistoryVersions(r).length === 0)
}

// 2. 缺失材料：按钮与执行口径一致，作废不受影响
{
  const r = row(2, { '设计图纸': '  ' })
  const decision = evaluateArchiveAction(r, '提交归档')
  check('缺失材料判定', !decision.ok && decision.ok === false && (decision as {reason: string}).reason === 'missingMaterials')
  check('缺失清单', JSON.stringify(decision.ok ? [] : decision.missing) === JSON.stringify(['设计图纸']))
  check('按钮不显示归档', !listAvailableActions(r).includes('提交归档'), listAvailableActions(r))
  check('缺失时仍可作废', applyArchiveAction(r, '作废档案').ok === true)
}

// 3. 首次归档 → v1；重复提交不改版本
{
  const r = row(3)
  const out = applyArchiveAction(r, '提交归档')
  check('首次归档成功', out.ok && out.row.status === '已归档' && out.row[VERSION_FIELD] === 1, out)
  check('首次归档pending', out.ok && out.row.pending === true && out.row.abnormal === false)
  const dup = applyArchiveAction(out.row, '提交归档')
  check('重复提交拒绝', !dup.ok)
  check('重复提交版本不变', !dup.ok && out.row[VERSION_FIELD] === 1)
  check('重复提交文案', !dup.ok && dup.message.includes('重复提交不会生成新版本'), dup.message)
  check('已归档动作集', JSON.stringify(listAvailableActions(out.row)) === JSON.stringify(['更新档案', '作废档案']))
}

// 4. 更新 → 待更新，版本不变；重复更新拒绝
{
  const r0 = ok(row(4), '提交归档')
  const up = applyArchiveAction(r0, '更新档案')
  check('更新成功', up.ok && up.row.status === '待更新' && up.row[VERSION_FIELD] === 1)
  check('待更新动作集', JSON.stringify(listAvailableActions(up.row)) === JSON.stringify(['提交归档', '作废档案']))
  const dup = applyArchiveAction(up.row, '更新档案')
  check('重复更新拒绝', !dup.ok && dup.message.includes('重复提交不会改变版本'), dup.message)
}

// 5. 待更新重新归档 → v2
{
  let r = ok(row(5), '提交归档')
  r = ok(r, '更新档案')
  const resub = applyArchiveAction(r, '提交归档')
  check('重新归档v2', resub.ok && resub.row.status === '已归档' && resub.row[VERSION_FIELD] === 2, resub)
  const hist = archiveHistoryVersions(resub.row)
  check('历史版本v1/v2', JSON.stringify(hist) === JSON.stringify([
    { version: 1, statusLabel: '已归档', note: '历史版本' },
    { version: 2, statusLabel: '已归档', note: '当前版本' },
  ]), hist)
  check('重复提交v2拒绝', !applyArchiveAction(resub.row, '提交归档').ok)
}

// 6. 作废终态：只读，三入口口径一致；历史版本保留
{
  let r = (applyArchiveAction(row(6), '提交归档') as {row: EntryRow}).row
  r = (applyArchiveAction(r, '更新档案') as {row: EntryRow}).row
  r = (applyArchiveAction(r, '提交归档') as {row: EntryRow}).row
  const v = (applyArchiveAction(r, '作废档案') as {row: EntryRow}).row
  check('作废状态', v.status === '已作废' && v.pending === false && v.abnormal === true && v[VERSION_FIELD] === 2)
  check('作废后无按钮', listAvailableActions(v).length === 0)
  for (const a of ['提交归档', '更新档案', '作废档案']) {
    const d = applyArchiveAction(v, a)
    check(`作废后${a}只读拒绝`, !d.ok && d.message.includes('已作废') && d.message.includes(a), d.message)
  }
  const hist = archiveHistoryVersions(v)
  check('作废保留历史', hist.length === 2 && hist[1].note === '已作废' && hist[0].note === '历史版本', hist)
}

// 7. 待归档直接作废：无版本、无历史
{
  const v = (applyArchiveAction(row(7), '作废档案') as {row: EntryRow}).row
  check('直接作废无版本', v[VERSION_FIELD] === undefined)
  check('直接作废无历史', archiveHistoryVersions(v).length === 0)
  check('作废只读', !applyArchiveAction(v, '提交归档').ok && listAvailableActions(v).length === 0)
}

// 8. 未登记动作 / 未知材料类型
{
  const r = row(8)
  check('未知动作', !applyArchiveAction(r, '删除档案').ok)
  const r2 = row(8, { '设施类别': '雨污水检查井', '承建企业': '' })
  check('已登记类型按其材料判定', (applyArchiveAction(r2, '提交归档') as {ok: true}).ok === true)
  const r3 = row(8, { '设施类别': '完全未知类别', '竣工日期': '' })
  const d3 = applyArchiveAction(r3, '提交归档')
  check('未知类型回落默认材料', !d3.ok && d3.message.includes('竣工日期'), d3.message)
}

// 9. 经 local-service 持久化流转 + 导出不变
resetModule('facility_archive')
{
  // 种子 id1=待归档（材料字段非空）→ 归档成功，版本 v1
  const a1 = runAction('facility_archive', 1, '提交归档')
  check('服务层归档', a1.ok && a1.message.includes('第 1 版'), a1)
  const a1dup = runAction('facility_archive', 1, '提交归档')
  check('服务层重复提交', !a1dup.ok && a1dup.message.includes('重复提交不会生成新版本'), a1dup)
  // 种子 id2=已归档：旧通用逻辑允许"提交归档"乱跳，现只读拒绝
  const a2submit = runAction('facility_archive', 2, '提交归档')
  check('服务层已归档重复', !a2submit.ok, a2submit)
  // 种子 id3=待更新：旧通用逻辑允许"作废后再更新"，现作废即终态
  const void3 = runAction('facility_archive', 3, '作废档案')
  check('服务层作废', void3.ok, void3)
  const afterVoid = runAction('facility_archive', 3, '提交归档')
  check('服务层作废只读', !afterVoid.ok && afterVoid.message.includes('已作废'), afterVoid)
  // 不存在的 id 提示不变
  const missing = runAction('facility_archive', 999, '作废档案')
  check('缺失id提示', !missing.ok && missing.message === '没有找到编号为 999 的设施档案', missing)
  // 导出表头仍只有：编号 + 8 个字段 + 当前状态，版本字段不进导出
  const csv = exportEntries('facility_archive').content.replace(/^﻿/, '')
  const header = csv.split('\n')[0].split(',')
  check('导出表头不变', JSON.stringify(header) === JSON.stringify(['编号', '档案编号', '设施名称', '设施类别', '所属区域', '竣工日期', '设计图纸', '承建企业', '档案状态', '当前状态']), header)
  check('导出版本不泄露', !csv.includes(VERSION_FIELD))
  check('导出行数不变', csv.split('\n').length === 4, csv.split('\n').length)
  resetModule('facility_archive')
}

// 10. 页面按钮集与执行结果一致（按钮上有的都能执行成功）
{
  for (const status of ['待归档', '已归档', '待更新', '已作废']) {
    let r = row(10, { status, [VERSION_FIELD]: 1 })
    for (const a of listAvailableActions(r)) {
      const o = applyArchiveAction(r, a)
      check(`${status}按钮${a}可执行`, o.ok, o.message)
      if (o.ok) r = o.row
    }
    for (const a of ['提交归档', '更新档案', '作废档案']) {
      if (!listAvailableActions(r).includes(a)) {
        check(`${status}隐藏动作${a}执行被拒`, !applyArchiveAction(r, a).ok)
      }
    }
  }
}

console.log(`\n${passed} checks passed`)
