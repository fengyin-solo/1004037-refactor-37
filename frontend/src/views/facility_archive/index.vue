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
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in rowActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="openHistory(row)">历史版本</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无设施档案数据，可先登记设施档案</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条设施档案记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="historyTarget" class="modal-mask" @click.self="closeHistory">
      <div class="modal-card" role="dialog" aria-modal="true" aria-label="历史版本">
        <header class="modal-head">
          <h3>历史版本 · {{ historyTarget['档案编号'] }}</h3>
          <button class="btn ghost" type="button" @click="closeHistory">关闭</button>
        </header>
        <table class="data-table">
          <thead>
            <tr>
              <th>版本</th>
              <th>状态</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in historyVersions" :key="item.version">
              <td>第 {{ item.version }} 版</td>
              <td>{{ item.statusLabel }}</td>
              <td>{{ item.note }}</td>
            </tr>
            <tr v-if="!historyVersions.length">
              <td colspan="3" class="empty-state">该档案尚未归档，暂无历史版本</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  archiveHistoryVersions,
  listAvailableActions,
  type ArchiveHistoryVersion,
} from '@/data/archive-rules'
import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('facility_archive')
const columns = ["档案编号", "设施名称", "设施类别", "所属区域", "竣工日期", "设计图纸", "承建企业", "档案状态"]
const statuses = ["待归档", "已归档", "待更新", "已作废"]
const stats = [{"label": "档案总数", "value": 0}, {"label": "待归档档案", "value": 0}, {"label": "待更新档案", "value": 0}]

const rows = ref<EntryRow[]>([])
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

// 可执行动作直接读共用规则，页面不再自维护一份动作清单，和执行入口天然一致。
function rowActions(row: EntryRow): string[] {
  return listAvailableActions(row)
}

const historyTargetId = ref<number | null>(null)
const historyTarget = computed<EntryRow | null>(
  () => rows.value.find((row) => Number(row.id) === historyTargetId.value) ?? null,
)
const historyVersions = computed<ArchiveHistoryVersion[]>(() =>
  historyTarget.value ? archiveHistoryVersions(historyTarget.value) : [],
)

function openHistory(row: EntryRow) {
  historyTargetId.value = Number(row.id)
}

function closeHistory() {
  historyTargetId.value = null
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

function runAction(action: string, row: EntryRow) {
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
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '设施档案列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal-card {
  width: 480px;
  max-width: calc(100vw - 32px);
  background: #fff;
  border-radius: 8px;
  padding: 16px;
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.2);
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.modal-head h3 {
  margin: 0;
  font-size: 15px;
}
</style>
