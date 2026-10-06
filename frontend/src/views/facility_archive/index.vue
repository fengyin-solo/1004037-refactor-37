<template>
  <section class="page" data-module="facility_archive">
    <header class="page-head">
      <div>
        <h2>设施档案管理</h2>
        <p class="page-desc">维护设施档案，围绕档案编号、设施名称、设施类别、所属区域做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记设施档案</button>
        <button class="btn" type="button" @click="exportRows">导出设施档案清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>版本</th>
          <th>材料</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td>{{ versionLabel(row) }}</td>
          <td>
            <span v-if="missingLabels(row).length" class="error-text">
              缺 {{ missingLabels(row).join('、') }}
            </span>
            <span v-else>齐全</span>
          </td>
          <td class="row-actions">
            <template v-for="action in availableActions(row)" :key="action">
              <button class="link" type="button" @click="runAction(action, row)">{{ action }}</button>
            </template>
            <span v-if="!availableActions(row).length" class="read-only-hint">只读</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 4" class="empty-state">暂无设施档案数据，可先登记设施档案</td>
        </tr>
      </tbody>
    </table>

    <section class="history-block">
      <h3>历史版本（只读）</h3>
      <table v-if="history.length" class="data-table">
        <thead>
          <tr>
            <th>档案编号</th>
            <th>设施名称</th>
            <th>归档版本</th>
            <th>归档时间</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in history" :key="`${String(item.id)}-${String(item[snapshotVersionField])}`">
            <td>{{ item['档案编号'] ?? '—' }}</td>
            <td>{{ item['设施名称'] ?? '—' }}</td>
            <td>V{{ item[snapshotVersionField] }}</td>
            <td>{{ formatTime(item[snapshotAtField]) }}</td>
            <td>{{ item.status }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">暂无历史版本；档案更新并重新归档后，旧版本会保存在这里。</p>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条设施档案记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listArchiveHistory,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  ARCHIVE_SNAPSHOT_AT_FIELD,
  ARCHIVE_SNAPSHOT_VERSION_FIELD,
  ARCHIVE_STATUSES,
  archiveVersion,
  availableArchiveActions,
  missingArchiveMaterials,
  type ArchiveAction,
  type ArchiveSnapshot,
} from '@/data/archive-rules'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('facility_archive')
const columns = ["档案编号", "设施名称", "设施类别", "所属区域", "竣工日期", "设计图纸", "承建企业", "档案状态"]
// 状态与动作按钮全部取自共用档案规则，页面不再各自硬编码。
const statuses = [...ARCHIVE_STATUSES]
const stats = [{"label": "档案总数", "value": 0}, {"label": "待归档档案", "value": 0}, {"label": "待更新档案", "value": 0}]
const snapshotVersionField = ARCHIVE_SNAPSHOT_VERSION_FIELD
const snapshotAtField = ARCHIVE_SNAPSHOT_AT_FIELD

const rows = ref<EntryRow[]>([])
const history = ref<ArchiveSnapshot[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function availableActions(row: EntryRow): ArchiveAction[] {
  return availableArchiveActions(row)
}

function missingLabels(row: EntryRow): string[] {
  return missingArchiveMaterials(row).map((item) => item.label)
}

function versionLabel(row: EntryRow): string {
  const version = archiveVersion(row)
  return version > 0 ? `V${version}` : '—'
}

function formatTime(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    return '—'
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '设施档案登记入口尚未接入审批流'
}

function runAction(action: ArchiveAction | string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    history.value = listArchiveHistory()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '设施档案列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.history-block {
  margin-top: 20px;
}

.history-block h3 {
  margin: 0 0 8px;
  font-size: 15px;
}

.read-only-hint {
  color: var(--muted);
  font-size: 12px;
}
</style>
