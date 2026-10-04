/** Project-level facts shared by the desktop, phone, agent tools, and WebDAV sync. */
export interface ProjectWorkspaceState {
  schemaVersion: 1
  goal: string
  salesAudience: string
  storyAudience: string
  channels: string[]
  systemOutline: string[]
  weeklyCadence: string
}

export const EMPTY_PROJECT_WORKSPACE: ProjectWorkspaceState = {
  schemaVersion: 1,
  goal: '',
  salesAudience: '',
  storyAudience: '',
  channels: [],
  systemOutline: [],
  weeklyCadence: '',
}

/** Older projects (and older remote backups) have no workspace state. */
export function parseProjectWorkspaceState(raw: string | null | undefined): ProjectWorkspaceState {
  if (!raw) return { ...EMPTY_PROJECT_WORKSPACE }
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...EMPTY_PROJECT_WORKSPACE }
    return {
      schemaVersion: 1,
      goal: typeof value.goal === 'string' ? value.goal : '',
      salesAudience: typeof value.salesAudience === 'string' ? value.salesAudience : '',
      storyAudience: typeof value.storyAudience === 'string' ? value.storyAudience : '',
      channels: stringList(value.channels),
      systemOutline: stringList(value.systemOutline),
      weeklyCadence: typeof value.weeklyCadence === 'string' ? value.weeklyCadence : '',
    }
  } catch {
    return { ...EMPTY_PROJECT_WORKSPACE }
  }
}

export function serializeProjectWorkspaceState(state: ProjectWorkspaceState): string {
  return JSON.stringify({
    schemaVersion: 1,
    goal: state.goal.trim(),
    salesAudience: state.salesAudience.trim(),
    storyAudience: state.storyAudience.trim(),
    channels: cleanLines(state.channels),
    systemOutline: cleanLines(state.systemOutline),
    weeklyCadence: state.weeklyCadence.trim(),
  })
}

export function validateProjectWorkspaceJson(raw: string): string {
  if (!raw.trim()) throw new Error('项目工作台配置不能为空；需要提供完整 JSON 对象')
  if (raw.length > 200_000) throw new Error('项目工作台配置超过 200KB，请移除素材正文，只保存事实与文件引用')
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('项目工作台配置必须是合法 JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('项目工作台配置顶层必须是 JSON 对象')
  return JSON.stringify(value)
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function cleanLines(value: string[]): string[] {
  return value.map((item) => item.trim()).filter(Boolean)
}
