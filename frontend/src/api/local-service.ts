import { MODULE_BY_KEY } from '@/data/modules'
import {
  ARCHIVE_ACTION_SUBMIT,
  ARCHIVE_KEY,
  ARCHIVE_VERSION_FIELD,
  archiveFlags,
  buildArchiveSnapshot,
  decideArchiveAction,
  nextArchiveVersion,
  type ArchiveSnapshot,
} from '@/data/archive-rules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 设施档案历史版本单独存放，不混进当前档案列表，列表/导出结果保持不变。
const ARCHIVE_HISTORY_KEY = 'underground-pipeline-inspection:archive-history'

function readArchiveHistory(): ArchiveSnapshot[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(ARCHIVE_HISTORY_KEY) ?? '[]')
    return Array.isArray(parsed) ? (parsed as ArchiveSnapshot[]) : []
  } catch {
    return []
  }
}

function appendArchiveHistory(snapshots: ArchiveSnapshot[]): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  const history = readArchiveHistory()
  history.push(...snapshots)
  window.localStorage.setItem(ARCHIVE_HISTORY_KEY, JSON.stringify(history))
}

export function listArchiveHistory(): ArchiveSnapshot[] {
  return readArchiveHistory()
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }

  // 设施档案的归档/更新/作废/版本判断全部走共用规则，其他模块沿用通用流转。
  if (key === ARCHIVE_KEY) {
    return runArchiveAction(meta, rows, index, action)
  }

  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

function runArchiveAction(
  meta: ModuleMeta,
  rows: EntryRow[],
  index: number,
  action: string,
): ActionResult {
  const current = rows[index]
  const decision = decideArchiveAction(current, action)
  if (!decision.allowed) {
    return { ok: false, message: decision.message }
  }

  // 重复提交、更新、作废都不产生新版本；只有重新归档成功才冻结旧版本并 +1。
  const snapshots: ArchiveSnapshot[] = []
  let updated: EntryRow = { ...current }
  if (decision.bumpVersion) {
    const oldVersion = Number(current[ARCHIVE_VERSION_FIELD])
    if (Number.isFinite(oldVersion) && oldVersion >= 1) {
      snapshots.push(buildArchiveSnapshot(current, oldVersion, new Date().toISOString()))
    }
    const version = nextArchiveVersion(current, decision)
    updated = { ...updated, [ARCHIVE_VERSION_FIELD]: version }
  }

  const flags = archiveFlags(decision.target)
  updated = {
    ...updated,
    status: decision.target,
    pending: flags.pending,
    abnormal: flags.abnormal,
  }

  const next = [...rows]
  next[index] = updated
  saveRows(meta.key, next)
  if (snapshots.length > 0) {
    appendArchiveHistory(snapshots)
  }

  const suffix =
    decision.action === ARCHIVE_ACTION_SUBMIT
      ? `，版本 V${updated[ARCHIVE_VERSION_FIELD]}`
      : ''
  return {
    ok: true,
    message: `${meta.entity}已${decision.action}，当前状态「${decision.target}」${suffix}`,
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  if (key === ARCHIVE_KEY && typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(ARCHIVE_HISTORY_KEY)
  }
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
