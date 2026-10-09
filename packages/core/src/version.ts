/**
 * 版本常量（唯一硬编码来源）。
 * 必须与根 / packages/core / apps/desktop / apps/mobile / apps/relay 的 package.json 保持一致；
 * tests/version.test.ts 会在单测里强制校验，防止再次漂移。
 */
export const APP_VERSION = '2.2.4'

/** 原生窗口标题。版本只从 APP_VERSION 取，避免手写漂移。 */
export function windowTitle(version = APP_VERSION): string {
  return `Jeff v${version}`
}
