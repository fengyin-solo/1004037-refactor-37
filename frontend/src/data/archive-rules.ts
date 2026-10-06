/**
 * 设施档案共用规则：归档、更新、作废、历史版本只在这一份文件里判断。
 *
 * 三个入口读同一份结果，谁也不自己另写判断：
 * 1. 动作执行（local-service.runAction）—— applyArchiveAction
 * 2. 页面可执行动作（facility_archive 页面按钮）—— listAvailableActions
 * 3. 历史版本查询（facility_archive 页面历史版本弹窗）—— archiveHistoryVersions
 *
 * 新增一种设施材料类型：只在 MATERIAL_TYPES 里登记一行必填材料即可，
 * 归档、更新、作废、历史版本的判断不用再到多处同步修改。
 */
import type { EntryRow } from './types'

export const ARCHIVE_MODULE_KEY = 'facility_archive'
export const ARCHIVE_ENTITY = '设施档案'

export const ARCHIVE_STATUS = {
  pending: '待归档',
  archived: '已归档',
  updating: '待更新',
  voided: '已作废',
} as const
export type ArchiveStatus = (typeof ARCHIVE_STATUS)[keyof typeof ARCHIVE_STATUS]

export const ARCHIVE_ACTION = {
  submit: '提交归档',
  update: '更新档案',
  void: '作废档案',
} as const
export type ArchiveAction = (typeof ARCHIVE_ACTION)[keyof typeof ARCHIVE_ACTION]

export const ARCHIVE_STATUSES: readonly ArchiveStatus[] = [
  ARCHIVE_STATUS.pending,
  ARCHIVE_STATUS.archived,
  ARCHIVE_STATUS.updating,
  ARCHIVE_STATUS.voided,
]

export const ARCHIVE_ACTIONS: readonly ArchiveAction[] = [
  ARCHIVE_ACTION.submit,
  ARCHIVE_ACTION.update,
  ARCHIVE_ACTION.void,
]

// 版本号写在行数据上的字段名（内部字段，不进列表列、不进导出表头）。
export const VERSION_FIELD = '档案版本'
const MATERIAL_TYPE_FIELD = '设施类别'

// 未登记材料类型的默认必填材料；历史数据（设施类别为占位值）走这份默认，保证现有档案可归档。
export const DEFAULT_REQUIRED_MATERIALS = ['竣工日期', '设计图纸', '承建企业']

export type MaterialTypeRule = {
  label: string
  requiredMaterials: string[]
}

/**
 * 材料类型登记表：新增材料类型只在这里加一行。
 * 字段名必须与档案行数据上的字段一致；留空即视为该材料缺失。
 */
export const MATERIAL_TYPES: Record<string, MaterialTypeRule> = {
  综合管廊: { label: '综合管廊', requiredMaterials: ['竣工日期', '设计图纸', '承建企业'] },
  排水泵站: { label: '排水泵站', requiredMaterials: ['竣工日期', '设计图纸', '承建企业'] },
  雨污水检查井: { label: '雨污水检查井', requiredMaterials: ['竣工日期', '设计图纸'] },
}

export function isArchiveModule(key: string): boolean {
  return key === ARCHIVE_MODULE_KEY
}

export function archiveStatus(row: Pick<EntryRow, 'status'>): ArchiveStatus | null {
  const status = String(row.status)
  return (ARCHIVE_STATUSES as readonly string[]).includes(status) ? (status as ArchiveStatus) : null
}

export function currentVersion(row: EntryRow): number {
  const raw = Number(row[VERSION_FIELD])
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1
}

/** 该档案所属材料类型要求的必填材料；未登记的类型回落默认材料。 */
export function requiredMaterialsFor(row: EntryRow): string[] {
  const type = String(row[MATERIAL_TYPE_FIELD] ?? '').trim()
  const rule = MATERIAL_TYPES[type]
  return rule ? rule.requiredMaterials : DEFAULT_REQUIRED_MATERIALS
}

/** 缺失的必填材料（字段为空或全空白即缺失）。所有入口对缺失的口径都来自这里。 */
export function missingMaterials(row: EntryRow): string[] {
  return requiredMaterialsFor(row).filter(
    (field) => String(row[field] ?? '').trim() === '',
  )
}

type ArchiveRejectReason =
  | 'unknownAction'
  | 'invalidStatus'
  | 'notArchived'
  | 'alreadyArchived'
  | 'alreadyUpdating'
  | 'voided'
  | 'missingMaterials'

export type ArchiveDecision =
  | { ok: true; target: ArchiveStatus; bumpVersion: boolean }
  | { ok: false; reason: ArchiveRejectReason; missing: string[] }

type Transition =
  | { allowed: true; target: ArchiveStatus; bumpVersion: boolean }
  | { allowed: false; reason: Exclude<ArchiveRejectReason, 'unknownAction' | 'invalidStatus' | 'missingMaterials'> }

// 唯一的状态流转表：执行、按钮可用性、历史版本共用同一张表。
//   待归档 ──提交归档──▶ 已归档（材料齐全，生成第 1 版）
//   已归档 ──更新档案──▶ 待更新（不产生新版本）
//   待更新 ──提交归档──▶ 已归档（材料齐全，版本 +1）
//   任意非作废状态 ──作废档案──▶ 已作废（终态只读）
const TRANSITIONS: Record<ArchiveStatus, Partial<Record<ArchiveAction, Transition>>> = {
  [ARCHIVE_STATUS.pending]: {
    [ARCHIVE_ACTION.submit]: { allowed: true, target: ARCHIVE_STATUS.archived, bumpVersion: true },
    [ARCHIVE_ACTION.update]: { allowed: false, reason: 'notArchived' },
    [ARCHIVE_ACTION.void]: { allowed: true, target: ARCHIVE_STATUS.voided, bumpVersion: false },
  },
  [ARCHIVE_STATUS.archived]: {
    [ARCHIVE_ACTION.submit]: { allowed: false, reason: 'alreadyArchived' },
    [ARCHIVE_ACTION.update]: { allowed: true, target: ARCHIVE_STATUS.updating, bumpVersion: false },
    [ARCHIVE_ACTION.void]: { allowed: true, target: ARCHIVE_STATUS.voided, bumpVersion: false },
  },
  [ARCHIVE_STATUS.updating]: {
    [ARCHIVE_ACTION.submit]: { allowed: true, target: ARCHIVE_STATUS.archived, bumpVersion: true },
    [ARCHIVE_ACTION.update]: { allowed: false, reason: 'alreadyUpdating' },
    [ARCHIVE_ACTION.void]: { allowed: true, target: ARCHIVE_STATUS.voided, bumpVersion: false },
  },
  [ARCHIVE_STATUS.voided]: {
    [ARCHIVE_ACTION.submit]: { allowed: false, reason: 'voided' },
    [ARCHIVE_ACTION.update]: { allowed: false, reason: 'voided' },
    [ARCHIVE_ACTION.void]: { allowed: false, reason: 'voided' },
  },
}

/**
 * 共用判断：某条档案此刻能不能执行某个动作。
 * 不做任何写入，页面按钮与真正执行都调它，保证两个入口结论一致。
 */
export function evaluateArchiveAction(row: EntryRow, action: string): ArchiveDecision {
  if (!(ARCHIVE_ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, reason: 'unknownAction', missing: [] }
  }
  const status = archiveStatus(row)
  if (!status) {
    return { ok: false, reason: 'invalidStatus', missing: [] }
  }
  const transition = TRANSITIONS[status][action as ArchiveAction]
  if (!transition || !transition.allowed) {
    const fallback: ArchiveRejectReason = transition ? transition.reason : 'invalidStatus'
    return { ok: false, reason: fallback, missing: [] }
  }
  // 归档（首次归档与更新后重新归档）都要求材料齐全；缺失材料的边界也只判这一次。
  if (action === ARCHIVE_ACTION.submit) {
    const missing = missingMaterials(row)
    if (missing.length > 0) {
      return { ok: false, reason: 'missingMaterials', missing }
    }
  }
  return { ok: true, target: transition.target, bumpVersion: transition.bumpVersion }
}

/** 拒绝原因到提示文案的唯一映射，保证各入口看到的边界提示一致。 */
export function archiveRejectMessage(
  action: string,
  reason: ArchiveRejectReason,
  missing: string[] = [],
): string {
  switch (reason) {
    case 'notArchived':
      return `${ARCHIVE_ENTITY}尚未归档，归档前按只读处理，不能更新，请先提交归档`
    case 'alreadyArchived':
      return `${ARCHIVE_ENTITY}已归档，重复提交不会生成新版本`
    case 'alreadyUpdating':
      return `${ARCHIVE_ENTITY}已在更新流程中，重复提交不会改变版本`
    case 'voided':
      return `${ARCHIVE_ENTITY}已作废，作废档案按只读处理，不能再执行「${action}」`
    case 'missingMaterials':
      return `归档材料不齐全，缺失：${missing.join('、')}，不能提交归档`
    case 'invalidStatus':
      return `${ARCHIVE_ENTITY}当前状态不可操作，请刷新后重试`
    case 'unknownAction':
    default:
      return `${ARCHIVE_ENTITY}没有登记「${action}」这个动作`
  }
}

export type ArchiveActionOutcome =
  | { ok: true; message: string; row: EntryRow }
  | { ok: false; message: string }

const ACTION_VERB: Record<ArchiveAction, string> = {
  [ARCHIVE_ACTION.submit]: '提交归档',
  [ARCHIVE_ACTION.update]: '更新',
  [ARCHIVE_ACTION.void]: '作废',
}

/**
 * 执行档案动作，返回下一行数据。唯一允许产生新版本的入口：
 * 待归档首次提交归档生成第 1 版；待更新重新归档版本 +1；其余任何重复提交都不改版本。
 */
export function applyArchiveAction(row: EntryRow, action: string): ArchiveActionOutcome {
  const decision = evaluateArchiveAction(row, action)
  if (!decision.ok) {
    return { ok: false, message: archiveRejectMessage(action, decision.reason, decision.missing) }
  }
  const next: EntryRow = {
    ...row,
    status: decision.target,
    pending: decision.target !== ARCHIVE_STATUS.voided,
    abnormal: action === ARCHIVE_ACTION.void,
  }
  let version: number | undefined
  if (action === ARCHIVE_ACTION.submit) {
    version = archiveStatus(row) === ARCHIVE_STATUS.pending ? 1 : currentVersion(row) + 1
    next[VERSION_FIELD] = version
  }
  const message =
    action === ARCHIVE_ACTION.submit
      ? `${ARCHIVE_ENTITY}已${ACTION_VERB[ARCHIVE_ACTION.submit]}，当前状态「${decision.target}」，第 ${version} 版`
      : `${ARCHIVE_ENTITY}已${ACTION_VERB[action as ArchiveAction]}，当前状态「${decision.target}」`
  return { ok: true, message, row: next }
}

/** 页面行内可执行动作：与执行入口共用 evaluateArchiveAction，判出来什么就显示什么。 */
export function listAvailableActions(row: EntryRow): string[] {
  return ARCHIVE_ACTIONS.filter((action) => evaluateArchiveAction(row, action).ok).map(String)
}

export type ArchiveHistoryVersion = {
  version: number
  statusLabel: string
  note: string
}

/**
 * 历史版本：从未成功归档过的档案（待归档，或待归档直接作废）没有版本；
 * 已归档后再作废的档案保留作废前的全部版本。版本口径与归档/更新动作完全共用。
 */
export function archiveHistoryVersions(row: EntryRow): ArchiveHistoryVersion[] {
  const status = archiveStatus(row)
  if (!status || status === ARCHIVE_STATUS.pending) {
    return []
  }
  // 没有版本字段 = 从未成功归档（从待归档直接作废），同样没有历史版本。
  if (row[VERSION_FIELD] === undefined || row[VERSION_FIELD] === '') {
    return []
  }
  const current = currentVersion(row)
  const versions: ArchiveHistoryVersion[] = []
  for (let version = 1; version <= current; version += 1) {
    if (version < current) {
      versions.push({ version, statusLabel: ARCHIVE_STATUS.archived, note: '历史版本' })
      continue
    }
    const note =
      status === ARCHIVE_STATUS.archived
        ? '当前版本'
        : status === ARCHIVE_STATUS.updating
          ? '更新中'
          : '已作废'
    versions.push({ version, statusLabel: status, note })
  }
  return versions
}
