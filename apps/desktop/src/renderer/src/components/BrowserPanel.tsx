import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { IPC, type BrowserAction, type BrowserConsoleEntry, type BrowserResult } from '@jeff/core'
import { registerBrowserHost, registerConsoleSink, takePendingStartUrl, unregisterBrowserHost } from '../browserHost'
import { Dialog } from './ui/Dialog'

/** 控制台采集上限：只留最近这些条（agent 分析错误只需要最近的现场，留太多反而不好读） */
const CONSOLE_KEEP = 200

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
  const [width, setWidth] = useState(() => Number(localStorage.getItem('jeff-browser-width') || 460))

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
        capturePage: () => Promise<{ toDataURL: () => string }>
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
      case 'screenshot': {
        const img = await wv.capturePage()
        return { dataUrl: img.toDataURL(), title: wv.getTitle(), url: wv.getURL() }
      }
      case 'get_content': {
        const maxChars = Number(args.max_chars) || 8000
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
    [navigateTo, ensureReady, waitForView],
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
    // 没记住过地址就不预加载：about:blank 会被 Electron 当成 https://about:blank/ 加载失败
    if (startUrl) wv.setAttribute('src', startUrl)
    wv.style.width = '100%'
    wv.style.height = '100%'
    wv.style.display = 'flex'
    wv.style.border = 'none'
    host.appendChild(wv)
    viewRef.current = wv

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

  // 宽度拖拽
  const dragging = useRef(false)
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return
      const next = Math.min(Math.max(window.innerWidth - e.clientX, 320), Math.round(window.innerWidth * 0.72))
      setWidth(next)
    }
    const onUp = () => {
      if (!dragging.current) return
      dragging.current = false
      document.body.classList.remove('browser-resizing')
      localStorage.setItem('jeff-browser-width', String(width))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [width])

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
    <div className="browser-panel" data-testid="browser-panel" style={{ width }}>
      <div
        className="browser-resizer"
        onMouseDown={() => {
          dragging.current = true
          document.body.classList.add('browser-resizing')
        }}
      />
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
  )
}
