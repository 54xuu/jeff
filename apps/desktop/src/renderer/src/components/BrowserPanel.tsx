import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { IPC, type BrowserAction, type BrowserConsoleEntry, type BrowserResult } from '@jeff/core'
import { registerBrowserHost, registerConsoleSink, takePendingStartUrl, unregisterBrowserHost } from '../browserHost'
import PaneResizer from './layout/PaneResizer'
import { clampBrowserWidth, clampListWidth, defaultBrowserWidth } from '../layout/panes'
import { useViewportWidth } from '../layout/useViewportWidth'
import { AUTO_VIEWPORT, describeViewport, fitViewport, parseResolutionText, type BrowserViewportRequest, type BrowserViewportSize } from '../browserViewport'
import { Dialog } from './ui/Dialog'

/** 控制台采集上限：只留最近这些条（agent 分析错误只需要最近的现场，留太多反而不好读） */
const CONSOLE_KEEP = 200

/**
 * 全页截图的高度上限（CSS 像素）。16384 是 Chromium/GPU 光栅化比较稳的边界，
 * 再高容易拿不到图；超出的页面会被截断，并在返回值里如实标 truncated（不假装截全了）。
 */
const FULL_PAGE_MAX = 16384

/** 全页截图前等图片加载的上限：懒加载图片进过视口才会真正回来，等不够就会拍到空白（公众号文章尤其明显） */
const IMAGE_WAIT_MS = 10_000

/** 全页截图最多分多少片（FULL_PAGE_MAX / 最小视口高，留足余量；正常页面十几片） */
const MAX_SLICES = 40

/** 两个地址是否指向同一页（忽略结尾斜杠与 query/hash；信息不全时保守判为「是」） */
function samePage(a: string, b: string): boolean {
  if (!a || !b) return true
  try {
    const ua = new URL(a)
    const ub = new URL(b)
    const norm = (u: URL): string => `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`
    return norm(ua) === norm(ub)
  } catch {
    return a === b
  }
}

/**
 * 内置浏览器面板（界面右侧，不改变原有布局）。
 *
 * 为什么用命令式创建 <webview> 而不是写 JSX：webview 的属性（partition/webpreferences）
 * 在 React 里没有类型定义，且必须在挂载前设置才生效；命令式创建时序可控，
 * 事件监听也不会被 React 的合成事件层干扰。
 *
 * agent 通过 jeff_browser_* 工具下发的动作由 browserHost 路由到这里的 exec；
 * 页面不响应时由主进程侧超时兜底（见 BridgeBrowserControl）。
 */
export default function BrowserPanel(): React.JSX.Element {
  const browser = useStore((s) => s.browser)
  const setBrowser = useStore((s) => s.setBrowser)
  const layout = useStore((s) => s.layout)
  const setLayout = useStore((s) => s.setLayout)
  const persistLayout = useStore((s) => s.persistLayout)
  const winWidth = useViewportWidth()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<HTMLElement | null>(null)
  const readyRef = useRef<Promise<void> | null>(null)
  const readyResolveRef = useRef<(() => void) | null>(null)
  /** 地址栏的实时值：go() 必须读这里而不是 store —— store 更新与回车可能在同一帧，读到的是旧值 */
  const addressRef = useRef('')
  /**
   * 控制台采集缓冲（当前页面的现场）。
   * 为什么放在渲染层：console-message 是 webview 的事件，主进程看不到；agent 的
   * jeff_browser_get_console 与面板上的红点读的是同一份数据。资源加载失败（图片/脚本/接口 404）
   * 不走 console-message，由主进程 watchBrowserResourceErrors 补采后经 IPC 投递进来
   * （见 browserHost.emitConsoleEntry）——两条来源汇进这一个缓冲。
   */
  const consoleRef = useRef<BrowserConsoleEntry[]>([])
  /**
   * 主文档加载失败的原因（did-fail-load 写入；导航开始时清空）。
   * 带 url 一起记：面板里可能同时有两条加载在跑（例如面板刚挂载时恢复上次地址 + agent 立刻导航），
   * 只有「失败的地址就是本次要打开的地址」才算这次导航失败，否则会把旧地址的失败算到新导航头上。
   */
  const loadErrorRef = useRef<{ url: string; message: string } | null>(null)
  const [showConsole, setShowConsole] = useState(false)
  // 宽度分两层：store 里是偏好值（落盘），这里按窗口与左栏实时夹出「当前生效宽度」
  const listWidth = clampListWidth(layout.listWidth, winWidth)
  const width = clampBrowserWidth(layout.browserWidth, winWidth, layout.listVisible, listWidth)
  const viewportReq = browser.viewport
  const setBrowserViewport = useStore((s) => s.setBrowserViewport)
  /**
   * 最新的视口偏好（渲染期同步进 ref）。
   * 为什么要 ref：面板重开时 webview 是新建的，而「应用视口」的 effect 声明在创建 webview 的 effect
   * **之前**，那一轮它先跑、此时还没有 webview —— 于是新建出来的 webview 会停在铺满尺寸，
   * 人/agent 设好的分辨率在重开面板后就丢了（实测踩到）。创建处直接读这个 ref 补一次，时序才确定。
   */
  const viewportReqRef = useRef(viewportReq)
  viewportReqRef.current = viewportReq
  /** 实际生效的视口像素（4:3 这类比例视口随面板变）：显示在工具栏提示里，agent 拿到的也是它 */
  const [viewportSize, setViewportSize] = useState<BrowserViewportSize | null>(null)
  const [vpMenuOpen, setVpMenuOpen] = useState(false)
  const [vpInput, setVpInput] = useState('')
  const [vpError, setVpError] = useState('')
  const vpMenuRef = useRef<HTMLDivElement | null>(null)

  /**
   * 把视口设置应用到 webview 元素。
   *
   * 为什么要直接改元素的内联宽高：webview 没有 viewport 属性，**页面视口就是这个元素的盒尺寸**。
   * 只有改盒尺寸，页面里的 window.innerWidth、媒体查询、以及截图取到的画面范围才会一起变
   * ——这正是「按 4:3 / 1697x1063 看页面并截图」的前提（用缩放是另一回事，innerWidth 不会变）。
   *
   * 返回值是实际生效像素，回给 agent（jeff_browser_set_viewport 的返回值）。
   */
  const applyViewport = useCallback((req: BrowserViewportRequest): BrowserViewportSize | null => {
    const host = hostRef.current
    if (!host) return null
    // 比例模式不能有滚动条：滚动条会吃掉可用宽度，算出的视口和容器互相追赶、来回抖；
    // 精确像素模式恰恰相反——它就该比面板大，所以允许面板内滚动查看。
    host.style.overflow = req.mode === 'fixed' ? 'auto' : 'hidden'
    const eff = fitViewport(req, { width: host.clientWidth, height: host.clientHeight })
    host.classList.toggle('browser-view--boxed', req.mode !== 'auto')
    const wv = viewRef.current as unknown as HTMLElement | null
    if (wv) {
      // flex:none 必须显式写：否则 1697px 的盒在窄面板里会被 flex 压缩，视口就不是请求值了
      wv.style.flex = 'none'
      wv.style.width = req.mode === 'auto' ? '100%' : `${eff.width}px`
      wv.style.height = req.mode === 'auto' ? '100%' : `${eff.height}px`
    }
    setViewportSize(eff)
    return eff
  }, [])

  /**
   * 视口偏好变化 / 容器尺寸变化都要重算。
   * 面板拖宽、窗口缩放时若不算，4:3 视口就停在旧尺寸（而它本该贴着面板自适应）；
   * 精确像素模式则相反——那是用户点名的分辨率，面板怎么变都不动它（只在 overflow 里滚动）。
   */
  useEffect(() => {
    if (!browser.visible) return
    const host = hostRef.current
    if (!host) return
    applyViewport(viewportReq)
    const ro = new ResizeObserver(() => {
      if (viewportReq.mode === 'ratio') applyViewport(viewportReq)
    })
    ro.observe(host)
    return () => ro.disconnect()
  }, [browser.visible, viewportReq, applyViewport])

  // 分辨率菜单：Esc / 点空白关闭（与 ModelPickerCombo 同一套交互约定）
  useEffect(() => {
    if (!vpMenuOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setVpMenuOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    // outside-click 延后一拍再挂：否则打开菜单的那一次点击会立刻把它关掉
    let onDoc: ((e: MouseEvent) => void) | null = null
    const timer = window.setTimeout(() => {
      onDoc = (e: MouseEvent): void => {
        if (!vpMenuRef.current?.contains(e.target as Node)) setVpMenuOpen(false)
      }
      document.addEventListener('mousedown', onDoc)
    }, 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('keydown', onKey)
      if (onDoc) document.removeEventListener('mousedown', onDoc)
    }
  }, [vpMenuOpen])

  /** 采集一条记录并同步错误数给工具栏（导航开始时清空：上一页的报错不该算到下一页头上） */
  const pushConsole = useCallback(
    (entry: Omit<BrowserConsoleEntry, 'at'>) => {
      const list = consoleRef.current
      list.push({ ...entry, at: Date.now() })
      if (list.length > CONSOLE_KEEP) list.splice(0, list.length - CONSOLE_KEEP)
      const errors = list.filter((e) => e.level === 'error' || e.level === 'load').length
      setBrowser({ errorCount: errors })
    },
    [setBrowser],
  )

  // 主进程补采的记录投递到同一份缓冲；面板卸载时注销，免得记到下一个页面头上
  useEffect(() => {
    registerConsoleSink(pushConsole)
    return () => registerConsoleSink(null)
  }, [pushConsole])

  /**
   * 等 webview 挂载出来（面板刚被唤起时 viewRef 还是空的）。
   * 与 ensureReady 一起把「面板未打开 → agent 调用」这段时序变成可重试的等待，而不是直接失败。
   */
  const waitForView = useCallback(async (timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const wv = viewRef.current
      if (wv) return wv
      if (Date.now() >= deadline) throw new Error('浏览器面板未就绪（等待面板挂载超时）')
      await new Promise((r) => setTimeout(r, 100))
    }
  }, [])

  /**
   * 就绪探测：直接试调一次 webview 方法，成功即代表「已挂载且可用」。
   *
   * 为什么不用 dom-ready 事件：实测存在页面已加载（did-navigate 都到了）但 dom-ready 未触发的情况，
   * 只靠事件会永久卡在「未就绪」，agent 的工具调用全部失败。探测式判断把时序问题变成可重试的问题。
   */
  const ensureReady = useCallback(
    async (timeoutMs = 6000): Promise<void> => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const wv = viewRef.current as unknown as { executeJavaScript: (c: string) => Promise<unknown> } | null
        if (wv) {
          try {
            await wv.executeJavaScript('1')
            return
          } catch (err) {
            if (Date.now() >= deadline) throw new Error(`浏览器面板未就绪：${String((err as Error)?.message || err).slice(0, 200)}`)
          }
        } else if (Date.now() >= deadline) {
          throw new Error('浏览器面板未就绪（等待面板挂载超时）')
        }
        await new Promise((r) => setTimeout(r, 120))
      }
    },
    [],
  )

  /**
   * 导航到指定地址。
   * 先用 loadURL（正常路径）；若 webview 尚未就绪（Electron 会报 "must be attached / dom-ready"），
   * 退回设置 src 属性——即便还没触发过任何加载，webview 也会在挂载后自行导航。
   */
  const navigateTo = useCallback(
    async (url: string): Promise<{ url: string; title: string }> => {
      const wv = (await waitForView()) as unknown as {
        loadURL: (u: string) => Promise<void>
        setAttribute: (k: string, v: string) => void
        getURL: () => string
        getTitle: () => string
        isLoading: () => boolean
        executeJavaScript: (c: string) => Promise<unknown>
      }
      /** 导航前的标题：用来判断「读到的标题是不是上一页留下的」 */
      const prevTitle = ((): string => {
        try {
          return (wv.getTitle() || '').trim()
        } catch {
          return ''
        }
      })()
      /**
       * 等页面给出真标题再返回。
       * webview 在页面还没标题时会把**地址**当标题返回，直接透传会让 agent 以为页面标题就是 URL
       * （真实场景：agent 汇报「已打开 http://127.0.0.1:46765」，用户看不出打开的是什么页）。
       * 优先读页面自己的 document.title，最多等 4s，等不到就如实返回空标题而不是假标题。
       */
      const settle = async (): Promise<{ url: string; title: string }> => {
        const deadline = Date.now() + 4000
        for (;;) {
          const live = wv.getURL() || url
          let dom = ''
          try {
            dom = String(await wv.executeJavaScript('document.title || ""')).trim()
          } catch {
            /* 页面还不能执行脚本（导航刚提交/跨进程切换中） */
          }
          const loading = wv.isLoading()
          const title = dom || (loading ? '' : (wv.getTitle() || '').trim())
          const meaningful = !!title && title !== live && (title !== prevTitle || !loading)
          if (meaningful || Date.now() >= deadline) return { url: live, title: title === live ? '' : title }
          await new Promise((r) => setTimeout(r, 150))
        }
      }
      try {
        await wv.loadURL(url)
      } catch (err) {
        const msg = String((err as Error)?.message || err)
        // 只有「未就绪」才退回 src；真实网络/URL 错误照实抛出，不能把自己的失败说成成功
        if (!/must be attached|dom-ready|not attached|GUEST_VIEW_MANAGER/i.test(msg) || /ERR_INVALID_URL|ERR_NAME|ERR_CONNECTION|ERR_ABORTED/.test(msg)) {
          throw new Error(msg.replace(/^Error invoking remote method '[^']+':\s*/, ''))
        }
        wv.setAttribute('src', url)
        await new Promise((r) => setTimeout(r, 300))
      }
      const settled = await settle()
      // loadURL 对「连接被拒 / 域名解析失败」这类失败仍会 resolve（失败是 did-fail-load 异步报的），
      // 所以这里必须回头查一次真失败：否则 agent 会拿到 ok:true 并宣称「已打开页面」。
      const failed = loadErrorRef.current
      if (failed && samePage(failed.url, settled.url || url)) throw new Error(failed.message)
      return settled
    },
    [waitForView],
  )

  /** 执行一个动作，返回可 JSON 序列化的数据 */
  const exec = useCallback(
    async (action: BrowserAction, args: Record<string, unknown>): Promise<unknown> => {
      const wv = (await waitForView()) as HTMLElement & {
        loadURL: (u: string) => Promise<void>
        canGoBack: () => boolean
        canGoForward: () => boolean
        goBack: () => void
        goForward: () => void
        reload: () => void
        stop: () => void
        getURL: () => string
        getTitle: () => string
        isLoading: () => boolean
        executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>
        /** 截图把它交给主进程（CDP 按这个 id 找到页面，按请求的矩形重新栅格化） */
        getWebContentsId: () => number
      }

      const page = async (code: string): Promise<unknown> => {
        await ensureReady()
        const el = viewRef.current as unknown as { executeJavaScript: (c: string, g?: boolean) => Promise<unknown> }
        return el.executeJavaScript(code, true)
      }
      const sameOriginGuard = (url: string) => {
        if (!/^https?:\/\//i.test(url)) throw new Error('只支持 http/https 地址')
        return url
      }
      /** 等页面把这次尺寸变更重排完（两帧足够覆盖媒体查询/自适应布局的同步重排） */
      const settleLayout = async (): Promise<void> => {
        try {
          await page('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))')
        } catch {
          /* 页面暂时不能执行脚本也无妨：后面的截图流程里还会再测一次 */
        }
      }
      /** 页面自己报告的视口事实（尺寸、滚动高、还没加载完的图片）：截图完整性靠它对账 */
      const measureGuest = async (): Promise<{
        width: number
        height: number
        dpr: number
        scrollWidth: number
        scrollHeight: number
        clientWidth: number
        scrollY: number
        imagesPending: number
        imagesLazy: number
      }> =>
        (await page(`(() => {
          const de = document.documentElement;
          const body = document.body;
          const imgs = Array.from(document.images);
          return {
            width: window.innerWidth,
            height: window.innerHeight,
            dpr: window.devicePixelRatio || 1,
            scrollWidth: Math.max(de.scrollWidth, body ? body.scrollWidth : 0),
            scrollHeight: Math.max(de.scrollHeight, body ? body.scrollHeight : 0),
            clientWidth: de.clientWidth,
            scrollY: Math.round(window.scrollY || 0),
            imagesPending: imgs.filter((i) => (i.currentSrc || i.getAttribute('src')) && !i.complete).length,
            imagesLazy: imgs.filter((i) => !i.getAttribute('src') && (i.getAttribute('data-src') || i.getAttribute('data-original'))).length,
          };
        })()`)) as {
          width: number
          height: number
          dpr: number
          scrollWidth: number
          scrollHeight: number
          clientWidth: number
          scrollY: number
          imagesPending: number
          imagesLazy: number
        }
      /**
       * 截图前的尺寸校验：渲染表面只覆盖到窗口大小出头一点，请求超出这一档时 Chromium 会把表面
       * 平铺/裁掉（实测窗口 1290x748 下请求 1697x1063：图尺寸对、内容整体错位）。
       * 与其给一张「看着像、其实不全」的图，不如明确拒绝 + 给出可操作建议。
       */
      const guardShotSize = (width: number, height: number): void => {
        const maxW = window.innerWidth
        const maxH = window.innerHeight
        if (width > maxW || height > maxH) {
          throw new Error(
            `截图范围 ${width}x${height} 超过 Jeff 窗口（${maxW}x${maxH}）——这块画面在当前窗口里渲不全，` +
              '截出来会是残缺/错位的图。请把窗口放大（或拉宽右侧面板），或把分辨率改小；只想看整页可以先用「自适应」或「4:3」。',
          )
        }
      }
      /**
       * 页面截图：交给主进程走 CDP 按「请求的矩形」重新栅格化。
       *
       * 为什么不在渲染层用 webview.capturePage()（两条弯路都实测过，别再试）：
       * ① 它给的是渲染器**已呈现的那一帧**，尺寸不由你定（请求 5659 高、拿回 1946）；
       * ② 元素被面板裁切时尺寸更怪（请求 1697x1063 拿回 3356x1946），拉回请求尺寸只会得到空白图。
       * CDP clip 以 CSS 像素计；高 DPI 屏上实际 PNG 可能按设备像素出图（含 1.25/1.375 这类非整数 DPR），
       * 主进程会按等比压回请求尺寸。跨 DPR 的契约仍然是「落盘图 = 视口 CSS 像素」。
       */
      const pageShot = async (
        width: number,
        height: number,
        beyondViewport: boolean,
        offsetY = 0,
      ): Promise<{ dataUrl: string; width: number; height: number }> => {
        if (typeof wv.getWebContentsId !== 'function') throw new Error('这个环境下拿不到页面 id，无法截图')
        const shot = (await api.invoke(IPC.browserPageShot, {
          webContentsId: wv.getWebContentsId(),
          width,
          height,
          beyondViewport,
          y: Math.max(0, Math.round(offsetY)),
        })) as {
          dataUrl: string
          width: number
          height: number
        }
        if (!shot?.dataUrl) throw new Error('截图失败：未取到画面')
        return shot
      }
      /** 把分片图（dataURL）解成可画到画布上的位图 */
      const loadShot = (dataUrl: string): Promise<HTMLImageElement> =>
        new Promise((resolve, reject) => {
          const img = new Image()
          img.onload = () => resolve(img)
          img.onerror = () => reject(new Error('分片图解码失败，整页截图未完成'))
          img.src = dataUrl
        })
      /**
       * 先滚一遍页面，把懒加载内容引出来（公众号文章的图是 data-src，进过视口才会真正加载）。
       *
       * 为什么必须自己滚：整页截图走 CDP 的 captureBeyondViewport，它**不会替你滚动**，
       * 没进过视口的懒加载图片在整页图里就是空白。滚完回到顶部，之后的截图从页首开始。
       */
      const primeLazyContent = async (limit: number): Promise<void> => {
        const code = `(async () => {
          // 记下固定/粘性定位元素：分片截图时第二片起要隐掉，否则顶栏会在每一片里重复
          window.__jeffSticky = Array.from(document.querySelectorAll('*')).filter((el) => {
            const pos = getComputedStyle(el).position;
            return pos === 'fixed' || pos === 'sticky';
          });
          const step = Math.max(240, window.innerHeight - 120);
          const limit = ${Math.max(0, Math.floor(limit))};
          for (let y = 0; y < limit; y += step) {
            window.scrollTo(0, y);
            await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 60)));
          }
          window.scrollTo(0, 0);
          await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 60)));
          return window.scrollY;
        })()`
        try {
          await page(code)
        } catch {
          /* 页面不允许脚本滚动（极少）：照常继续，截到的就是已加载的部分 */
        }
      }
      /**
       * 整页截图（含滚动部分）：**文档坐标分片 + 画布拼接**。
       *
       * 为什么必须分片：渲染表面只覆盖到窗口尺寸出头一点，请求远大于窗口的高度时 Chromium 会把
       * 表面平铺/裁掉（实测请求 5659 高的整页，拿回来的图是「页首内容重复」的假图）。
       * 于是按「视口高」切成一列片，每片都在可靠范围内，再按文档位移在画布上拼起来。
       *
       * 每片用 **文档坐标偏移 + captureBeyondViewport** 取，而不是「滚动页面再截当前视口」：
       * 实测滚过之后截到的是一张没有内容的空表面（滚动区域不会重新光栅化），只剩滚动条。
       * 代价：固定/粘性定位元素（顶栏）会在每片里重复出现，所以第二片起把它们隐掉（首片保留：
       * 顶栏本来就该出现在页首）。截完还原样式，页面布局自始至终没被动过。
       */
      const captureFullPage = async (title: string, url: string): Promise<Record<string, unknown>> => {
        const start = await measureGuest()
        guardShotSize(Math.round(start.width), Math.round(start.height))
        // 整页图按**内容宽**取（不含纵向滚动条那一列）：否则每一片右侧都会重复出现一条滚动条
        const width = Math.max(1, Math.round(start.clientWidth || start.width))
        const viewportH = Math.max(1, Math.round(start.height))
        // 先滚一遍引出懒加载内容（公众号的图是 data-src，进过视口才会回来），再等它们真的加载完
        await primeLazyContent(Math.min(Math.max(start.scrollHeight, viewportH), FULL_PAGE_MAX))
        const deadline = Date.now() + IMAGE_WAIT_MS
        for (;;) {
          const m = await measureGuest()
          if ((m.imagesPending === 0 && m.imagesLazy === 0) || Date.now() >= deadline) break
          await new Promise((r) => setTimeout(r, 300))
        }
        const measured = await measureGuest()
        const fullHeight = Math.max(measured.scrollHeight, viewportH)
        const totalHeight = Math.min(fullHeight, FULL_PAGE_MAX)
        const slices = Math.ceil(totalHeight / viewportH)
        if (slices > MAX_SLICES) throw new Error(`整页太高（${fullHeight}px），超出单张图上限 ${FULL_PAGE_MAX}px，请分段查看`)
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = totalHeight
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('无法创建画布来拼接整页截图')
        try {
          for (let i = 0; i < slices; i++) {
            const at = i * viewportH
            // 第二片起隐掉固定/粘性定位元素：它们相对视口定位，每片都会重复拍到（顶栏一片就够）
            if (i === 1) await page('window.__jeffSticky && window.__jeffSticky.forEach((el) => { el.style.visibility = "hidden" })')
            // 关键：用**文档坐标**偏移 + captureBeyondViewport 取每片，不依赖页面滚动状态。
            // （实测：滚动后再截会拿到一张没内容的空表面——页面滚动区在这条路径上不会被重新光栅化；
            //  而 beyondViewport 会按请求的文档矩形重新栅格化，滚没滚过都算数。）
            const shot = await pageShot(width, viewportH, true, at)
            const img = await loadShot(shot.dataUrl)
            const take = Math.min(viewportH, totalHeight - at)
            if (take > 0) ctx.drawImage(img, 0, 0, width, take, 0, at, width, take)
          }
        } finally {
          await page('window.__jeffSticky && window.__jeffSticky.forEach((el) => { el.style.visibility = "" }); window.scrollTo(0, 0)').catch(() => {})
        }
        return {
          dataUrl: canvas.toDataURL('image/png'),
          title,
          url,
          full_page: true,
          width,
          height: totalHeight,
          fullHeight,
          ...(fullHeight > totalHeight ? { truncated: true } : {}),
        }
      }
      switch (action) {
        case 'navigate': {
          return await navigateTo(sameOriginGuard(String(args.url || '')))
        }
      case 'back':
        if (!wv.canGoBack()) throw new Error('已经是第一页，无法后退')
        wv.goBack()
        return { ok: true }
      case 'forward':
        if (!wv.canGoForward()) throw new Error('已经是最后一页，无法前进')
        wv.goForward()
        return { ok: true }
      case 'reload':
        wv.reload()
        return { ok: true }
      case 'state':
        return { url: wv.getURL(), title: wv.getTitle(), loading: wv.isLoading() }
      /**
       * 设置视口分辨率（人用工具栏菜单、agent 用 jeff_browser_set_viewport，都落到同一份 store）。
       * 精确像素模式下页面里 window.innerWidth/innerHeight 就是请求的那两个数——这是「按指定分辨率截图」的地基。
       */
      case 'set_viewport': {
        const mode = String(args.mode || '').trim().toLowerCase()
        let req: BrowserViewportRequest = AUTO_VIEWPORT
        if (mode === 'fixed') {
          const vw = Number(args.width)
          const vh = Number(args.height)
          if (!Number.isInteger(vw) || !Number.isInteger(vh)) throw new Error('精确分辨率需要 width 与 height 两个整数')
          req = { mode: 'fixed', width: vw, height: vh }
        } else if (mode === 'ratio') {
          const aspect = Number(args.aspect)
          req = { mode: 'ratio', aspect: aspect > 0 ? aspect : 4 / 3, ratio: String(args.ratio || '4:3') }
        }
        setBrowserViewport(req)
        const eff = applyViewport(req) ?? { width: 0, height: 0 }
        await settleLayout()
        const m = await measureGuest().catch(() => null)
        return {
          mode: req.mode,
          ratio: req.mode === 'ratio' ? req.ratio : '',
          width: eff.width,
          height: eff.height,
          ...(m ? { page_width: m.width, page_height: m.height } : {}),
          note:
            req.mode === 'fixed'
              ? `视口已设为 ${eff.width}x${eff.height}（页面 window.innerWidth/innerHeight 就是这个值；面板放不下时面板内滚动查看）。`
              : req.mode === 'ratio'
                ? `视口已按 ${req.ratio} 比例自适应面板：当前 ${eff.width}x${eff.height}。`
                : '视口已恢复自适应（铺满面板）。',
        }
      }
      case 'screenshot': {
        const fullPage = args.full_page === true || /^(true|1|yes|full)$/i.test(String(args.full_page ?? '').trim())
        const title = wv.getTitle()
        const url = wv.getURL()
        if (fullPage) return await captureFullPage(title, url)
        // 可视区截图：尺寸 = 页面视口（innerWidth/innerHeight），与 set_viewport 报的生效分辨率一致
        const m = await measureGuest()
        guardShotSize(Math.round(m.width), Math.round(m.height))
        const shot = await pageShot(Math.round(m.width), Math.round(m.height), false)
        return {
          dataUrl: shot.dataUrl,
          title,
          url,
          full_page: false,
          width: shot.width,
          height: shot.height,
          page_width: m.width,
          page_height: m.height,
          page_scroll_y: m.scrollY,
        }
      }
      case 'get_content': {
        // 上限防「一次把上百 KB 正文灌进模型上下文」；下限防参数写成 0 时拿到空文本
        const maxChars = Math.min(Math.max(Number(args.max_chars) || 8000, 500), 200000)
        const selector = args.selector ? String(args.selector) : ''
        const out = (await page(`(() => {
          const sel = ${JSON.stringify(selector)};
          const root = sel ? document.querySelector(sel) : document.body;
          if (!root) return { error: '选择器没匹配到元素: ' + sel };
          const text = (root.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
          const interactive = [];
          const nodes = root.querySelectorAll('a,button,input,textarea,select,[role=button],[onclick]');
          for (const el of nodes) {
            if (interactive.length >= 80) break;
            const r = el.getBoundingClientRect();
            const visible = r.width > 0 && r.height > 0;
            if (!visible) continue;
            const label = (el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').trim().slice(0, 60);
            interactive.push({
              tag: el.tagName.toLowerCase(),
              type: el.getAttribute('type') || '',
              label,
              id: el.id || '',
              name: el.getAttribute('name') || '',
              selector: el.id ? '#' + el.id : (el.tagName.toLowerCase() + (el.getAttribute('type') ? '[type=' + el.getAttribute('type') + ']' : '')),
            });
          }
          return { title: document.title, url: location.href, text: text.slice(0, ${maxChars}), interactive, truncated: text.length > ${maxChars} };
        })()`)) as Record<string, unknown>
        // 页面自己在报错时，正文里看不出来（错误只进控制台）——这里带上提示，让 agent 知道该去读谁
        const errs = consoleRef.current.filter((e) => e.level === 'error' || e.level === 'load').length
        return errs > 0 ? { ...out, page_errors: errs, hint: `该页面有 ${errs} 条错误（控制台/加载失败），用 jeff_browser_get_console 读详情。` } : out
      }
      case 'click': {
        const selector = args.selector ? String(args.selector) : ''
        const text = args.text ? String(args.text) : ''
        const r = (await page(`(() => {
          const sel = ${JSON.stringify(selector)};
          const txt = ${JSON.stringify(text)};
          let el = sel ? document.querySelector(sel) : null;
          if (!el && txt) {
            const cands = Array.from(document.querySelectorAll('a,button,[role=button],input[type=submit],input[type=button],[onclick],li,span,div'));
            el = cands.find((c) => (c.innerText || c.value || '').trim() === txt)
              || cands.find((c) => (c.innerText || c.value || '').trim().includes(txt))
              || null;
          }
          if (!el) return { ok: false, error: '没找到可点击的元素（selector=' + sel + ', text=' + txt + '）' };
          el.scrollIntoView({ block: 'center' });
          const label = (el.innerText || el.value || el.tagName).trim().slice(0, 60);
          el.click();
          return { ok: true, clicked: label };
        })()`)) as { ok: boolean; error?: string; clicked?: string }
        if (!r?.ok) throw new Error(r?.error || '点击失败')
        return r
      }
      case 'type': {
        const selector = String(args.selector || '')
        const text = String(args.text ?? '')
        const clear = args.clear !== false
        const submit = !!args.submit
        const nextExpr = clear ? 'String(TEXT)' : '(el.value || "") + String(TEXT)'
        const code = `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { ok: false, error: '没找到输入框: ' + ${JSON.stringify(selector)} };
          const TEXT = ${JSON.stringify(text)};
          el.scrollIntoView({ block: 'center' });
          el.focus();
          // 下拉框走「选选项」而不是设置 value：<select> 没有 HTMLInputElement 的 value setter，
          // 用原生 setter 会抛 Illegal invocation（填表流程里选科室/病区都是这种控件）
          if (el.tagName === 'SELECT') {
            const want = String(TEXT).trim();
            const opts = Array.from(el.options);
            const hit = opts.find((o) => o.value === want)
              || opts.find((o) => (o.textContent || '').trim() === want)
              || opts.find((o) => (o.textContent || '').trim().includes(want));
            if (!hit) {
              return { ok: false, error: '下拉框里没有匹配「' + want + '」的选项。可选项：' + opts.map((o) => ((o.textContent || '').trim()) + '=' + o.value).join(' / ') };
            }
            el.value = hit.value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, value: el.value, selected: (hit.textContent || '').trim() };
          }
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          const next = ${nextExpr};
          if (setter) setter.call(el, next); else el.value = next;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          if (${submit}) {
            for (const type of ['keydown','keypress','keyup']) {
              el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            }
            if (el.form && typeof el.form.requestSubmit === 'function') { try { el.form.requestSubmit(); } catch (e) {} }
          }
          return { ok: true, value: el.value };
        })()`
        const r = (await page(code)) as { ok: boolean; error?: string; value?: string }
        if (!r?.ok) throw new Error(r?.error || '输入失败')
        return r
      }
      /**
       * 把本机文件「选进」页面的 <input type=file>。
       *
       * 为什么用 DataTransfer 造 File 而不是给 Chromium 设真实路径：webview 没有暴露
       * 「设置选中文件」的接口，而 Chromium 允许页面用 DataTransfer 组装 input.files——
       * 这是同一份提交数据（表单/FormData 提交时用的就是它），所以服务端能真的收到字节。
       * 文件内容由主进程读盘后以 base64 下发（见 core 的 jeff_browser_upload）。
       */
      case 'upload': {
        const selector = String(args.selector || '').trim()
        const name = String(args.name || 'upload.bin')
        const mime = String(args.mime || 'application/octet-stream')
        const b64 = String(args.base64 || '')
        if (!selector) throw new Error('selector 不能为空（要放进哪个 <input type=file>）')
        if (!b64) throw new Error('文件内容为空（base64 为空）')
        const r = (await page(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { ok: false, error: '没找到文件输入框: ' + ${JSON.stringify(selector)} };
          if (el.tagName !== 'INPUT' || el.type !== 'file') {
            return { ok: false, error: '目标不是 <input type="file">：<' + el.tagName.toLowerCase() + (el.getAttribute('type') ? ' type=' + el.getAttribute('type') : '') + '>（文件只能放进 file 类型的输入框）' };
          }
          const raw = atob(${JSON.stringify(b64)});
          const bytes = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
          const file = new File([bytes], ${JSON.stringify(name)}, { type: ${JSON.stringify(mime)} });
          const dt = new DataTransfer();
          dt.items.add(file);
          el.files = dt.files;
          el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          if (!el.files || el.files.length === 0) return { ok: false, error: '文件没能放进输入框（页面可能禁止了赋值）' };
          return { ok: true, name: el.files[0].name, size: el.files[0].size, count: el.files.length };
        })()`)) as { ok: boolean; error?: string; name?: string; size?: number; count?: number }
        if (!r?.ok) throw new Error(r?.error || '上传文件失败')
        return { ...r, note: '文件只是「选中」了：要让服务端真的收到，还得提交表单（jeff_browser_click 点提交按钮，或 jeff_browser_type 带 submit）。' }
      }
      /** 读取当前页面采集到的错误（agent「分析错误」用；与工具栏红点同一份数据） */
      case 'console': {
        const level = String(args.level || 'error').toLowerCase()
        const limit = Math.min(Math.max(Number(args.limit) || 50, 1), CONSOLE_KEEP)
        const all = consoleRef.current
        const isErr = (e: BrowserConsoleEntry): boolean => e.level === 'error' || e.level === 'load'
        const want = level === 'all' ? all : level === 'warning' ? all.filter((e) => e.level !== 'info') : all.filter(isErr)
        return {
          url: wv.getURL(),
          title: wv.getTitle(),
          filtered_by: level,
          error_count: all.filter(isErr).length,
          total_collected: all.length,
          entries: want.slice(-limit).map((e) => ({
            level: e.level,
            message: e.message.slice(0, 600),
            ...(e.source ? { source: e.source } : {}),
            ...(e.line ? { line: e.line } : {}),
          })),
          note:
            want.length === 0
              ? '当前页面没有采集到错误（采集范围：控制台 error、未捕获异常、主帧加载失败）。'
              : '这些是页面自己报出来的错误：先看 message 定位问题，需要时改页面源码后刷新再看。',
        }
      }
      default:
        throw new Error(`不支持的浏览器动作：${action}`)
      }
    },
    [navigateTo, ensureReady, waitForView, applyViewport, setBrowserViewport],
  )

  /**
   * 注册给 browserHost —— 只在面板可见时注册。
   *
   * 这一条是「agent 调用自动打开面板」能否生效的关键：面板隐藏时若也把自己注册成可用，
   * runBrowserAction 会认为无需唤起，直接调用 → viewRef 为空 → 工具报「面板未就绪」而不是自动打开。
   */
  useEffect(() => {
    if (!browser.visible) return
    registerBrowserHost(exec)
    return () => unregisterBrowserHost(exec)
  }, [browser.visible, exec])

  // 创建 <webview>（仅在面板打开时挂载，关闭即销毁，不留后台进程）
  useEffect(() => {
    if (!browser.visible) return
    const host = hostRef.current
    if (!host || viewRef.current) return
    const startUrl = browser.url || takePendingStartUrl() || localStorage.getItem('jeff-browser-last-url') || ''
    let resolveReady: (() => void) | null = null
    readyRef.current = new Promise<void>((r) => (resolveReady = r))
    readyResolveRef.current = resolveReady
    const wv = document.createElement('webview') as HTMLElement
    wv.setAttribute('partition', 'persist:jeff-browser')
    // 缺省禁止弹窗：target="_blank" / window.open 会被 Chromium 静默吞掉。
    // 打开 allowpopups 只是让 guest 能发出新窗口请求，主进程仍一律 deny，并改成当前页原地跳转。
    wv.setAttribute('allowpopups', '')
    // 没记住过地址就不预加载：about:blank 会被 Electron 当成 https://about:blank/ 加载失败
    if (startUrl) wv.setAttribute('src', startUrl)
    wv.style.width = '100%'
    wv.style.height = '100%'
    wv.style.display = 'flex'
    wv.style.border = 'none'
    host.appendChild(wv)
    viewRef.current = wv
    // 新建的 webview 立刻套用当前视口偏好：否则重开面板后分辨率会丢（见 viewportReqRef 的说明）
    applyViewport(viewportReqRef.current)

    const el = wv as unknown as {
      getURL: () => string
      getTitle: () => string
      isLoading: () => boolean
      addEventListener: (t: string, fn: (e: unknown) => void) => void
    }
    const sync = () => {
      const url = el.getURL() || ''
      // about:blank（未加载任何页面）不写进地址栏与记忆，否则会把地址栏污染成 https://about:blank/
      const real = url && !/^about:blank/.test(url) ? url : ''
      if (real) localStorage.setItem('jeff-browser-last-url', real)
      setBrowser({ url: real, title: el.getTitle() || '', loading: el.isLoading(), ...(real ? { address: real } : {}) })
      // 状态同步给主进程（agent 据此了解当前页面）
      void api.invoke(IPC.browserState, { visible: true, url: real, title: el.getTitle() || '', loading: el.isLoading() }).catch(() => {})
    }
    const onReady = () => {
      readyResolveRef.current?.()
      readyResolveRef.current = null
      sync()
    }
    // 事件日志（诊断用：Electron webview 的就绪事件时序在个别情况下不触发，需要现场可查）
    const log = (name: string) => {
      const w = window as unknown as { __jeffBrowserEvents?: string[] }
      w.__jeffBrowserEvents = [...(w.__jeffBrowserEvents || []), `${name}@${Date.now()}`]
    }
    // dom-ready 只在页面真正加载后触发；没记住地址时不会有它，靠 did-attach 兜底「可调用 webview 方法」
    el.addEventListener('dom-ready', () => {
      log('dom-ready')
      onReady()
    })
    el.addEventListener('did-attach', () => {
      log('did-attach')
      onReady()
    })
    el.addEventListener('did-start-loading', () => {
      log('did-start-loading')
      // 新页面开始加载：上一页的报错现场作废（否则「这个页面有错误」会张冠李戴）
      consoleRef.current = []
      loadErrorRef.current = null
      setBrowser({ loading: true, errorCount: 0 })
    })
    /**
     * 控制台采集：webview 的 console-message 事件（Electron 新旧签名都兼容）。
     * 页面的 console.error、console.warn 与未捕获异常走这条通道；**子资源 404 不走**
     * （实测：仅靠这里采集不到 <img src="/missing.json"> 的失败），那类由主进程的
     * webRequest 采集后经 browser-console 推送进来，两条来源汇进同一个缓冲。
     */
    el.addEventListener('console-message', (e: unknown) => {
      const ev = (e || {}) as { level?: number | string; message?: string; line?: number; lineNumber?: number; sourceId?: string }
      const raw = typeof ev.level === 'number' ? (ev.level >= 3 ? 'error' : ev.level === 2 ? 'warning' : 'info') : String(ev.level || 'info')
      const level: BrowserConsoleEntry['level'] = raw === 'error' ? 'error' : raw === 'warning' || raw === 'warn' ? 'warning' : 'info'
      const line = Number(ev.line ?? ev.lineNumber ?? 0)
      pushConsole({
        level,
        message: String(ev.message || ''),
        ...(ev.sourceId ? { source: String(ev.sourceId) } : {}),
        ...(line > 0 ? { line } : {}),
      })
    })
    el.addEventListener('did-stop-loading', () => {
      log('did-stop-loading')
      sync()
    })
    el.addEventListener('did-navigate', () => {
      log('did-navigate')
      sync()
    })
    el.addEventListener('did-navigate-in-page', sync)
    el.addEventListener('page-title-updated', sync)
    el.addEventListener('did-fail-load', (e: unknown) => {
      const ev = e as { errorDescription?: string; validatedURL?: string; isMainFrame?: boolean }
      if (ev.isMainFrame === false) return
      setBrowser({ loading: false })
      sync()
      // ERR_ABORTED = 导航被后续操作取代（很常见），不是真失败，不进错误列表
      if (ev.errorDescription && ev.errorDescription !== 'ERR_ABORTED') {
        console.warn('[jeff-browser] 加载失败:', ev.errorDescription, ev.validatedURL)
        // 记下来：loadURL 的 Promise 在「连接被拒」这类失败上仍会 resolve（Chromium 是异步报失败的），
        // 不给 navigate 留这个标志的话工具会回 ok:true —— agent 于是以为自己打开了页面。
        const message = `页面加载失败：${ev.errorDescription}${ev.validatedURL ? `（${ev.validatedURL}）` : ''}`
        loadErrorRef.current = { url: ev.validatedURL || '', message }
        pushConsole({ level: 'load', message })
      }
    })
    return () => {
      readyResolveRef.current?.()
      readyResolveRef.current = null
      wv.remove()
      viewRef.current = null
      // 面板关闭：告诉主进程不可用，agent 调用时会得到「请先打开浏览器」的提示而不是等到超时
      void api.invoke(IPC.browserState, { visible: false, url: '', title: '', loading: false }).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browser.visible])

  // 地址栏跟随（外部导航后同步）
  useEffect(() => {
    if (browser.visible && browser.url) localStorage.setItem('jeff-browser-last-url', browser.url)
  }, [browser.visible, browser.url])

  const act = (action: 'back' | 'forward' | 'reload') => {
    const wv = viewRef.current as unknown as { canGoBack: () => boolean; canGoForward: () => boolean; goBack: () => void; goForward: () => void; reload: () => void } | null
    if (!wv) return
    if (action === 'back') wv.canGoBack() && wv.goBack()
    else if (action === 'forward') wv.canGoForward() && wv.goForward()
    else wv.reload()
  }

  const go = () => {
    let url = addressRef.current.trim()
    if (!url) return
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`
    void navigateTo(url).catch((e: unknown) => console.warn('[jeff-browser] 打开失败:', e))
  }

  const openExternal = () => {
    if (browser.url) void api.invoke(IPC.fsOpenPath, { target: browser.url }).catch(() => {})
  }

  if (!browser.visible) return <></>

  return (
    <>
      <PaneResizer
        side="right"
        width={width}
        clamp={(w) => clampBrowserWidth(w, winWidth, layout.listVisible, listWidth)}
        onResize={(w) => setLayout({ browserWidth: w }, { persist: false })}
        onCommit={persistLayout}
        onReset={() => setLayout({ browserWidth: defaultBrowserWidth(winWidth) })}
        onCollapse={() => setBrowser({ visible: false })}
        collapseTitle="收起内置浏览器"
        testId="browser-resizer"
      />
      <div className="browser-panel" data-testid="browser-panel" style={{ width }}>
        <div className="browser-bar">
          <button className="icon-btn" title="后退" data-testid="browser-back" onClick={() => act('back')}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <button className="icon-btn" title="前进" data-testid="browser-forward" onClick={() => act('forward')}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
          <button className="icon-btn" title="刷新" data-testid="browser-reload" onClick={() => act('reload')}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" />
            </svg>
          </button>
          <input
            className="browser-address"
            data-testid="browser-address"
            value={browser.address}
            spellCheck={false}
            placeholder="输入网址后回车"
            onChange={(e) => {
              addressRef.current = e.target.value
              setBrowser({ address: e.target.value })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') go()
            }}
          />
          <div className="combo browser-resolution" ref={vpMenuRef}>
            <button
              type="button"
              className={`icon-btn ${viewportReq.mode === 'auto' ? '' : 'on'}`}
              title={`分辨率：${describeViewport(viewportReq, viewportSize || undefined)}（点击修改）`}
              data-testid="browser-resolution-btn"
              onClick={() => {
                setVpMenuOpen((v) => !v)
                setVpError('')
                setVpInput(viewportReq.mode === 'fixed' ? `${viewportReq.width}x${viewportReq.height}` : '')
              }}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="13" rx="2" />
                <path d="M9 21h6M12 17v4" />
              </svg>
            </button>
            {vpMenuOpen && (
              <div className="combo-menu browser-resolution-menu" data-testid="browser-resolution-menu">
                <button
                  type="button"
                  className={`combo-item ${viewportReq.mode === 'auto' ? 'on' : ''}`}
                  data-testid="browser-resolution-auto"
                  onClick={() => {
                    setBrowserViewport(AUTO_VIEWPORT)
                    setVpMenuOpen(false)
                  }}
                >
                  自适应（铺满面板）
                </button>
                <button
                  type="button"
                  className={`combo-item ${viewportReq.mode === 'ratio' ? 'on' : ''}`}
                  data-testid="browser-resolution-43"
                  onClick={() => {
                    setBrowserViewport({ mode: 'ratio', aspect: 4 / 3, ratio: '4:3' })
                    setVpMenuOpen(false)
                  }}
                >
                  4:3 比例（随面板自适应）
                </button>
                <div className="combo-group">自定义分辨率</div>
                <input
                  className="browser-resolution-input"
                  data-testid="browser-resolution-custom"
                  spellCheck={false}
                  placeholder="如 1697x1063"
                  value={vpInput}
                  onChange={(e) => {
                    setVpInput(e.target.value)
                    setVpError('')
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    const size = parseResolutionText(vpInput)
                    if (!size) {
                      setVpError('格式如 1697x1063（宽 320-5120 / 高 240-5120）')
                      return
                    }
                    setBrowserViewport({ mode: 'fixed', width: size.width, height: size.height })
                    setVpMenuOpen(false)
                  }}
                />
                {vpError ? (
                  <div className="browser-resolution-error" data-testid="browser-resolution-error">
                    {vpError}
                  </div>
                ) : (
                  <div className="browser-resolution-hint">{viewportSize ? `当前视口 ${viewportSize.width}x${viewportSize.height}` : '回车应用'}</div>
                )}
              </div>
            )}
          </div>
          <button className="icon-btn" title="在系统浏览器打开" onClick={openExternal}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <path d="M15 3h6v6M10 14L21 3" />
            </svg>
          </button>
          {browser.errorCount > 0 && (
            <button
              className="icon-btn browser-error-btn"
              title={`当前页面有 ${browser.errorCount} 条错误（点开看详情；agent 也能用 jeff_browser_get_console 读到同一份）`}
              data-testid="browser-errors"
              onClick={() => setShowConsole(true)}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                <path d="M12 9v4M12 17h.01" />
              </svg>
              <span className="browser-error-count" data-testid="browser-error-count">
                {browser.errorCount}
              </span>
            </button>
          )}
          <button className="icon-btn" title="关闭浏览器面板" data-testid="browser-close" onClick={() => setBrowser({ visible: false })}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="browser-view" ref={hostRef} data-testid="browser-view" />
        {browser.loading && <div className="browser-loading" />}
        {showConsole && (
          <Dialog title={`页面错误（${browser.errorCount}）`} onClose={() => setShowConsole(false)}>
            <ul className="browser-console-list" data-testid="browser-console-list">
              {consoleRef.current.length === 0 ? (
                <li className="cron-dim">当前页面没有采集到错误。</li>
              ) : (
                consoleRef.current.map((e, i) => (
                  <li key={`${e.at}-${i}`} className={`browser-console-item ${e.level}`}>
                    <span className="cron-badge">{e.level === 'load' ? '加载' : e.level === 'error' ? '错误' : e.level === 'warning' ? '警告' : '信息'}</span>
                    <span className="browser-console-msg">{e.message}</span>
                    {(e.source || e.line) && (
                      <span className="cron-dim">
                        {e.source ? e.source.replace(/^https?:\/\//, '') : ''}
                        {e.line ? `:${e.line}` : ''}
                      </span>
                    )}
                  </li>
                ))
              )}
            </ul>
            <p className="settings-tip">这些错误同样可以通过 jeff_browser_get_console 让智能体读取，用来自查页面为什么不对。</p>
          </Dialog>
        )}
      </div>
    </>
  )
}
