import type { JeffCore } from '@jeff/core'
import { normalizeSiYuanBaseUrl, SiYuanClient, type SiYuanStoredConfig } from '@jeff/core'
import type { SiYuanConfigInfo, SiYuanNotebook, SiYuanSearchResult, SiYuanTarget } from '@jeff/core'

const CONFIG_KEY = 'integration:siyuan'
const TARGET_KEY = 'settings:siyuanArchiveTarget'

function readConfig(core: JeffCore): SiYuanStoredConfig {
  const value = core.kv().getJSON<SiYuanStoredConfig | null>(CONFIG_KEY, null)
  return value && typeof value.baseUrl === 'string' && typeof value.token === 'string' ? value : { baseUrl: '', token: '' }
}

export function siYuanClient(core: JeffCore): SiYuanClient {
  return new SiYuanClient(() => readConfig(core))
}

export function getSiYuanConfig(core: JeffCore): SiYuanConfigInfo {
  const config = readConfig(core)
  return { baseUrl: config.baseUrl, tokenConfigured: Boolean(config.token) }
}

export function saveSiYuanConfig(core: JeffCore, input: { baseUrl: string; token?: string }): SiYuanConfigInfo {
  const baseUrl = normalizeSiYuanBaseUrl(input.baseUrl)
  const previous = readConfig(core)
  const token = input.token?.trim() || previous.token
  if (!token) throw new Error('请填写思源 Kernel API Token')
  core.kv().setJSON(CONFIG_KEY, { baseUrl, token })
  return { baseUrl, tokenConfigured: true }
}

export async function listSiYuanNotebooks(core: JeffCore): Promise<SiYuanNotebook[]> {
  return siYuanClient(core).listNotebooks()
}

export async function listSiYuanDocuments(core: JeffCore, notebookId: string): Promise<SiYuanSearchResult[]> {
  return siYuanClient(core).listDocuments(notebookId)
}

export async function searchSiYuan(core: JeffCore, keyword: string, notebookId = ''): Promise<SiYuanSearchResult[]> {
  return siYuanClient(core).search(keyword, { ...(notebookId ? { notebookId } : {}) })
}

export async function exportSiYuanMarkdown(core: JeffCore, docId: string): Promise<{ docId: string; path: string; markdown: string }> {
  return siYuanClient(core).read(docId)
}

export function getSiYuanTarget(core: JeffCore): SiYuanTarget {
  const target = core.kv().getJSON<SiYuanTarget | null>(TARGET_KEY, null)
  return target && typeof target.notebookId === 'string' && typeof target.parentDocId === 'string'
    ? target
    : { notebookId: '', parentDocId: '' }
}

export function saveSiYuanTarget(core: JeffCore, target: SiYuanTarget): SiYuanTarget {
  const normalized = { notebookId: target.notebookId.trim(), parentDocId: target.parentDocId.trim() }
  if (!normalized.notebookId && normalized.parentDocId) throw new Error('选择父文档前请先选择笔记本')
  core.kv().setJSON(TARGET_KEY, normalized)
  return normalized
}
