/** 项目群内角色：只有 leader（群主）与 worker（工作者），不做开发/产品等细分类。 */
export type ProjectRole = 'leader' | 'worker'

export const PROJECT_ROLES: ProjectRole[] = ['leader', 'worker']

/**
 * 归一化群内角色。
 * - leader → leader
 * - 其余一切（member / 开发 / ui / 测试 / 产品 / 空 …）→ worker
 */
export function normalizeProjectRole(role: string | null | undefined): ProjectRole {
  const r = (role || '').trim().toLowerCase()
  if (r === 'leader') return 'leader'
  return 'worker'
}

/** UI / briefing 展示用中文 */
export function projectRoleLabel(role: string | null | undefined): string {
  return normalizeProjectRole(role) === 'leader' ? '群主' : '工作者'
}
