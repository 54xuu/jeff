import fixture from '../../../packages/core/tests/fixtures/remote-crypto-vectors.json'
import { referenceFixture, type CryptoFixture } from '@jeff/core/remote'

/** 页面里跑同一套实现，和提交的向量逐项比对。 */
export function verifyInPage(): void {
  const got = referenceFixture()
  for (const key of Object.keys(fixture) as Array<keyof CryptoFixture>) {
    if (got[key] !== fixture[key]) throw new Error(`${key} 与测试向量不一致`)
  }
}
