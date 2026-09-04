import crypto from 'node:crypto'

/** 生成带前缀的短随机 id */
export function genId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`
}

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url')
}
