import { expect, test } from '@playwright/test'

const MOCK_PROFILE = {
  identity: {
    id: 'phone-test-client-9876543210',
    signSecret: 'dGVzdC1zaWduLXNlY3JldC1mb3ItZ29hbC1lMmUtdGVzdGluZw==',
    x25519Secret: 'dGVzdC14MjU1MTktc2VjcmV0LWZvci1nb2FsLWUyZS10ZXN0',
  },
  desktops: [
    {
      id: 'pc-work',
      name: 'MacBook Pro (开发机)',
      online: true,
      x25519: 'dGVzdC14MjU1MTktcGMtd29yay1rZXk=',
    },
    {
      id: 'pc-server',
      name: 'UBUNTU-PRODUCTION-HIGH-PERFORMANCE-SERVER-OFFICE-XUJIAN-2026-SUPER-LONG-NAME',
      online: false,
      x25519: 'dGVzdC14MjU1MTktcGMtc2VydmVyLWtleQ==',
    },
  ],
  activeId: 'pc-work',
}

test.describe('移动端「我」界面视觉与防溢出测试', () => {
  test('未绑定状态：展示个人卡片、绑定入口与安全项，无横向溢出', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.clear()
    })

    await page.goto('/')
    await expect(page.getByTestId('tab-me')).toBeVisible()
    await page.getByTestId('tab-me').click()

    // 1. 验证个人卡片
    const meSection = page.getByTestId('me')
    await expect(meSection).toBeVisible()
    const profile = page.getByTestId('me-profile')
    await expect(profile).toBeVisible()
    await expect(profile).toContainText('我的手机')
    await expect(profile).toContainText('未绑定')
    await expect(profile).toContainText('Jeff ID')

    // 2. 验证未绑定时直接展示绑定操作区
    const pairBox = page.getByTestId('pair-box')
    await expect(pairBox).toBeVisible()
    await expect(page.getByTestId('pair-paste')).toBeVisible()
    await expect(page.getByTestId('pair-go')).toBeVisible()

    // 3. 验证安全与设置项
    await expect(page.getByTestId('lock-app')).toBeVisible()
    await expect(page.locator('.wechat-hint')).toBeVisible()

    // 4. 验证底部导航栏完全可见且未被遮挡
    const tabBar = page.locator('.wechat-tabs')
    await expect(tabBar).toBeVisible()
    const tabBounding = await tabBar.boundingBox()
    const viewport = page.viewportSize()!
    expect(tabBounding).toBeTruthy()
    expect(tabBounding!.y + tabBounding!.height).toBeLessThanOrEqual(viewport.height + 1)

    // 5. 验证无横向溢出
    const hasHorizontalOverflow = await page.evaluate(() => {
      const el = document.querySelector('.wechat-me')
      if (!el) return false
      return el.scrollWidth > el.clientWidth
    })
    expect(hasHorizontalOverflow).toBe(false)

    await page.screenshot({ path: '../../.tmp/mobile-me-unbound.png', fullPage: false })
  })

  test('已绑定电脑状态：微信卡片分组精致展示，长设备名不溢出截断，可滚动到底部', async ({ page }) => {
    await page.addInitScript((profile) => {
      localStorage.setItem('jeff-phone-profile', JSON.stringify(profile))
    }, MOCK_PROFILE)

    await page.goto('/')
    await expect(page.getByTestId('tab-me')).toBeVisible()
    await page.getByTestId('tab-me').click()

    // 1. 验证个人卡片已连接状态
    const profile = page.getByTestId('me-profile')
    await expect(profile).toBeVisible()
    await expect(profile).toContainText('我的手机')

    // 2. 验证电脑列表卡片
    await expect(page.getByText('已连接电脑 (2)')).toBeVisible()

    const activePc = page.getByTestId('comp-item-pc-work')
    await expect(activePc).toBeVisible()
    await expect(activePc).toContainText('MacBook Pro (开发机)')
    await expect(activePc).toContainText('当前使用')

    const longNamePc = page.getByTestId('comp-item-pc-server')
    await expect(longNamePc).toBeVisible()
    await expect(longNamePc).toContainText('UBUNTU-PRODUCTION-HIGH-PERFORMANCE-SERVER')
    await expect(longNamePc).toContainText('切换 ›')

    // 3. 验证长设备名在视口内未发生横向溢出
    const viewport = page.viewportSize()!
    const longNamePcBox = await longNamePc.boundingBox()
    expect(longNamePcBox).toBeTruthy()
    expect(longNamePcBox!.x + longNamePcBox!.width).toBeLessThanOrEqual(viewport.width + 1)

    // 4. 验证整体容器无横向滚动条
    const hasHorizontalOverflow = await page.evaluate(() => {
      const el = document.querySelector('.wechat-me')
      if (!el) return false
      return el.scrollWidth > el.clientWidth
    })
    expect(hasHorizontalOverflow).toBe(false)

    await page.screenshot({ path: '../../.tmp/mobile-me-bound.png', fullPage: false })

    // 5. 测试折叠面板：“绑定另一台电脑”展开与收起
    const pairAnotherBtn = page.getByTestId('pair-another')
    await expect(pairAnotherBtn).toBeVisible()
    await expect(page.getByTestId('pair-box')).toBeHidden()

    await pairAnotherBtn.click()
    await expect(page.getByTestId('pair-box')).toBeVisible()
    await expect(page.getByTestId('pair-paste')).toBeVisible()
    await page.screenshot({ path: '../../.tmp/mobile-me-expanded.png', fullPage: false })

    await pairAnotherBtn.click()
    await expect(page.getByTestId('pair-box')).toBeHidden()

    // 6. 验证垂直滚动到底部，解绑按钮与安全项正常可见且可点击
    const unbindBtn = page.getByTestId('unbind')
    await unbindBtn.scrollIntoViewIfNeeded()
    await expect(unbindBtn).toBeVisible()
    const unbindBox = await unbindBtn.boundingBox()
    expect(unbindBox).toBeTruthy()
    expect(unbindBox!.x + unbindBox!.width).toBeLessThanOrEqual(viewport.width + 1)

    // 7. 测试解绑操作：先解绑当前主控，另一台自动接替成为当前主控
    await unbindBtn.click()
    await expect(page.getByText('已连接电脑 (1)')).toBeVisible()
    await expect(page.getByTestId('comp-item-pc-work')).toBeHidden()
    await expect(page.getByTestId('comp-item-pc-server')).toBeVisible()
    await expect(page.getByTestId('comp-item-pc-server')).toContainText('当前使用')

    // 再次解绑最后一台电脑，恢复完全未绑定状态
    await unbindBtn.click()
    await expect(page.getByTestId('pair-box')).toBeVisible()
    await expect(page.getByText('已连接电脑')).toBeHidden()
  })

  test('小屏手机适配（360x640）：各项卡片与按钮完整展现，无溢出', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 })
    await page.addInitScript((profile) => {
      localStorage.setItem('jeff-phone-profile', JSON.stringify(profile))
    }, MOCK_PROFILE)

    await page.goto('/')
    await page.getByTestId('tab-me').click()

    // 验证小屏下无横向溢出
    const overflowInfo = await page.evaluate(() => {
      const root = document.documentElement
      const me = document.querySelector('.wechat-me')
      return {
        docScrollWidth: root.scrollWidth,
        docClientWidth: root.clientWidth,
        meScrollWidth: me ? me.scrollWidth : 0,
        meClientWidth: me ? me.clientWidth : 0,
      }
    })
    expect(overflowInfo.docScrollWidth).toBeLessThanOrEqual(overflowInfo.docClientWidth)
    expect(overflowInfo.meScrollWidth).toBeLessThanOrEqual(overflowInfo.meClientWidth)

    // 验证底部导航栏在小屏下依然完好
    const tabBar = page.locator('.wechat-tabs')
    await expect(tabBar).toBeVisible()
    const tabBox = await tabBar.boundingBox()
    expect(tabBox!.y + tabBox!.height).toBeLessThanOrEqual(640 + 1)

    // 验证垂直滚动顺畅，可以滚动到解除绑定按钮
    const unbindBtn = page.getByTestId('unbind')
    await unbindBtn.scrollIntoViewIfNeeded()
    await expect(unbindBtn).toBeVisible()
  })

  test('暗色模式适配：遵循微信暗黑模式规范配色', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.addInitScript((profile) => {
      localStorage.setItem('jeff-phone-profile', JSON.stringify(profile))
    }, MOCK_PROFILE)

    await page.goto('/')
    await page.getByTestId('tab-me').click()

    await expect(page.getByTestId('me-profile')).toBeVisible()
    await expect(page.getByText('已连接电脑 (2)')).toBeVisible()

    await page.screenshot({ path: '../../.tmp/mobile-me-dark.png', fullPage: false })
  })
})
