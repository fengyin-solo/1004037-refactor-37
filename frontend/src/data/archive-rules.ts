import type { EntryRow } from './types'

/**
 * 设施档案规则：归档、更新、作废与历史版本共用同一份判断。
 *
 * 所有入口（页面动作、状态流转、历史版本、下载之外的读侧）都只读本文件，
 * 新增材料类型只改 ARCHIVE_MATERIAL_FIELDS 一处，不再到处同步。
 * 本文件只做纯判断，不碰 localStorage；落库由 local-service 负责。
 */

export const ARCHIVE_KEY = 'facility_archive'

export const ARCHIVE_STATUS_PENDING_ARCHIVE = '待归档'
export const ARCHIVE_STATUS_ARCHIVED = '已归档'
export const ARCHIVE_STATUS_PENDING_UPDATE = '待更新'
export const ARCHIVE_STATUS_VOID = '已作废'

/** 状态机的全部状态，顺序仅用于展示与统计。 */
export const ARCHIVE_STATUSES = [
  ARCHIVE_STATUS_PENDING_ARCHIVE,
  ARCHIVE_STATUS_ARCHIVED,
  ARCHIVE_STATUS_PENDING_UPDATE,
  ARCHIVE_STATUS_VOID,
] as const

export const ARCHIVE_ACTION_SUBMIT = '提交归档'
export const ARCHIVE_ACTION_UPDATE = '更新档案'
export const ARCHIVE_ACTION_VOID = '作废档案'

/** 页面动作按钮的顺序也由规则统一给出。 */
export const ARCHIVE_ACTIONS = [
  ARCHIVE_ACTION_SUBMIT,
  ARCHIVE_ACTION_UPDATE,
  ARCHIVE_ACTION_VOID,
] as const

/**
 * 归档必需的材料字段（即一种材料类型）。
 * 要支持新的材料类型，只在这里登记：缺失判断、可归档判断、历史快照会自动统一。
 */
export const ARCHIVE_MATERIAL_FIELDS = ['设计图纸'] as const

/** 版本号字段：随归档成功（首次归档或更新后重新归档）递增，其他动作不改变。 */
export const ARCHIVE_VERSION_FIELD = 'version'
/** 历史快照标记：命中即为只读的历史版本，不能再执行任何动作。 */
export const ARCHIVE_SNAPSHOT_FIELD = 'archiveSnapshot'
export const ARCHIVE_SNAPSHOT_VERSION_FIELD = 'snapshotVersion'
export const ARCHIVE_SNAPSHOT_AT_FIELD = 'snapshotAt'

export type ArchiveStatus = (typeof ARCHIVE_STATUSES)[number]
export type ArchiveAction = (typeof ARCHIVE_ACTIONS)[number]

type Fields = string | number | boolean | undefined

export type MissingMaterial = {
  field: string
  label: string
}

/**
 * 各动作允许的来源状态（状态机）。已作废不在任何动作的来源里 —— 天然只读。
 */
const ALLOWED_FROM: Record<ArchiveAction, readonly ArchiveStatus[]> = {
  // 「提交归档」既负责首次归档，也负责「待更新」重新归档（生成新版本）。
  [ARCHIVE_ACTION_SUBMIT]: [ARCHIVE_STATUS_PENDING_ARCHIVE, ARCHIVE_STATUS_PENDING_UPDATE],
  [ARCHIVE_ACTION_UPDATE]: [ARCHIVE_STATUS_ARCHIVED],
  [ARCHIVE_ACTION_VOID]: [ARCHIVE_STATUS_PENDING_ARCHIVE, ARCHIVE_STATUS_ARCHIVED, ARCHIVE_STATUS_PENDING_UPDATE],
}

/** 哪些动作要求材料齐全；不在这里的动作即使有材料缺失也允许。 */
const MATERIAL_REQUIRED_ACTIONS: ReadonlySet<ArchiveAction> = new Set<ArchiveAction>([
  ARCHIVE_ACTION_SUBMIT,
  ARCHIVE_ACTION_VOID,
])

function fieldValue(row: EntryRow, field: string): Fields {
  const value = row[field]
  if (typeof value === 'string') {
    return value.trim()
  }
  return value as Fields
}

/** 材料是否缺失：字段不存在或去空格后为空都算缺失。所有入口共用此判断。 */
export function missingArchiveMaterials(row: EntryRow): MissingMaterial[] {
  return ARCHIVE_MATERIAL_FIELDS.map((field) => String(field))
    .filter((field) => {
      const value = fieldValue(row, field)
      return value === undefined || value === ''
    })
    .map((field) => ({ field, label: field }))
}

/** 历史版本快照：只读，任何动作都不允许。 */
export function isArchiveSnapshot(row: EntryRow): boolean {
  return row[ARCHIVE_SNAPSHOT_FIELD] === true
}

/** 当前版本号：尚未归档过（待归档）视为 0，归档成功后从 1 开始。 */
export function archiveVersion(row: EntryRow): number {
  const raw = Number(row[ARCHIVE_VERSION_FIELD])
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
}

export type ArchiveDecision =
  | {
      allowed: true
      action: ArchiveAction
      target: ArchiveStatus
      /** 为 true 表示本次动作要生成一个新版本（提交归档成功）。 */
      bumpVersion: boolean
    }
  | {
      allowed: false
      action: ArchiveAction
      message: string
    }

/**
 * 档案动作的唯一判断入口：材料缺失、已作废只读、非法状态、重复提交都在这里给出一致结论。
 */
export function decideArchiveAction(row: EntryRow, action: string): ArchiveDecision {
  const known = ARCHIVE_ACTIONS.find((item) => item === action)
  if (!known) {
    return { allowed: false, action: action as ArchiveAction, message: `设施档案没有登记「${action}」这个动作` }
  }

  if (isArchiveSnapshot(row)) {
    return { allowed: false, action: known, message: '该记录是历史版本，仅可查看，不能再操作' }
  }

  const status = String(row.status) as ArchiveStatus

  if (MATERIAL_REQUIRED_ACTIONS.has(known)) {
    const missing = missingArchiveMaterials(row)
    if (missing.length > 0) {
      return {
        allowed: false,
        action: known,
        message: `缺少必备材料（${missing.map((item) => item.label).join('、')}），不能${known}`,
      }
    }
  }

  const allowedStatuses = ALLOWED_FROM[known]
  if (!allowedStatuses.includes(status)) {
    // 已作废档案：任何动作都得到一致的只读提示。
    if (status === ARCHIVE_STATUS_VOID) {
      return { allowed: false, action: known, message: '设施档案已作废，仅可查看，不能再更新或归档' }
    }
    return {
      allowed: false,
      action: known,
      message: `当前状态「${status}」不允许「${known}」`,
    }
  }

  // 提交归档：待归档 -> 已归档（V1）；待更新 -> 已归档（V+1）。
  // 更新/作废不产生新版本。
  const bumpVersion = known === ARCHIVE_ACTION_SUBMIT
  const target: ArchiveStatus =
    known === ARCHIVE_ACTION_SUBMIT
      ? ARCHIVE_STATUS_ARCHIVED
      : known === ARCHIVE_ACTION_UPDATE
        ? ARCHIVE_STATUS_PENDING_UPDATE
        : ARCHIVE_STATUS_VOID

  return { allowed: true, action: known, target, bumpVersion }
}

/** 某条档案当前可执行的动作；历史版本与已作废档案返回空列表（只读）。 */
export function availableArchiveActions(row: EntryRow): ArchiveAction[] {
  if (isArchiveSnapshot(row) || String(row.status) === ARCHIVE_STATUS_VOID) {
    return []
  }
  return ARCHIVE_ACTIONS.filter((action) => decideArchiveAction(row, action).allowed)
}

/** 落库后用于看板的待处理 / 异常标记，规则同样集中在此，避免各入口各算一套。 */
export function archiveFlags(target: ArchiveStatus): { pending: boolean; abnormal: boolean } {
  return {
    pending: target === ARCHIVE_STATUS_PENDING_ARCHIVE || target === ARCHIVE_STATUS_PENDING_UPDATE,
    abnormal: target === ARCHIVE_STATUS_VOID,
  }
}

/** 归档成功后应落入的新版本号；更新、作废不改版本。 */
export function nextArchiveVersion(row: EntryRow, decision: Extract<ArchiveDecision, { allowed: true }>): number {
  return decision.bumpVersion ? archiveVersion(row) + 1 : archiveVersion(row)
}

export type ArchiveSnapshot = EntryRow & {
  [ARCHIVE_SNAPSHOT_FIELD]: true
  [ARCHIVE_SNAPSHOT_VERSION_FIELD]: number
  [ARCHIVE_SNAPSHOT_AT_FIELD]: string
}

/**
 * 生成历史版本快照：在新版本落库前，把「被替换的旧版本」原样冻结进历史。
 * 只在提交归档产生新版本、且旧版本号 >= 1 时调用。
 */
export function buildArchiveSnapshot(row: EntryRow, version: number, at: string): ArchiveSnapshot {
  return {
    ...row,
    status: ARCHIVE_STATUS_ARCHIVED,
    pending: false,
    abnormal: false,
    [ARCHIVE_VERSION_FIELD]: version,
    [ARCHIVE_SNAPSHOT_FIELD]: true,
    [ARCHIVE_SNAPSHOT_VERSION_FIELD]: version,
    [ARCHIVE_SNAPSHOT_AT_FIELD]: at,
  }
}
