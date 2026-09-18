import http from 'node:http'

/**
 * 本地测试站：内置浏览器「agent 代操作网页」的靶子（封闭 E2E 用，不需要模型）。
 *
 * 为什么要自己起站、而不是只断言页面 DOM：判据必须能**在服务端侧取证**——
 * 表单点了没点、文件传上来没有（传上来的字节对不对）只有服务端知道，
 * 只看界面会被「看起来成功了」骗过去。
 *
 * 页面：
 *   /          首页（链接到下面各页）
 *   /wizard    三步向导：填姓名 → 选病区 + 备注 → 勾确认 → 提交（fetch POST /api/submit）
 *   /upload    文件上传：<input type=file> + 科室输入 + 上传按钮（fetch POST /api/upload，multipart）
 *   /react     受控输入（value 被自定义存取器接管）：验证「原生 setter + input 事件」这条路
 *   /broken    故意坏掉：console.error + 未捕获异常 + 404 子资源（验证「分析错误」）
 *   /slow      3 秒后才渲染内容（验证 navigate 会等到页面可用）
 *   /viewport  自报视口尺寸（window.innerWidth x innerHeight，随窗口变化实时更新）+ 可选高页面
 *              （?h=5200 撑出 5200px 高 + 底部标记）与懒加载图片（?lazy=3，图片延迟 800ms 才回来）
 *              —— 验证「设分辨率 / 视口截图尺寸 = 视口 / 全页截图含滚动部分」这三条契约
 * 取证接口：
 *   GET /__log → { submits, uploads, requests, notFound }
 */
export interface TestSiteUpload {
  /** multipart 正文里解析出的文件名（按 UTF-8 解码） */
  name: string
  /** 请求体字节数 */
  size: number
  /** multipart 正文字节数 */
  bytes: number
  /** multipart 正文（UTF-8 文本）：文件名、科室、文件内容都能直接 substring 断言 */
  body: string
  /** multipart 正文的 latin1 视图（逐字节，做偏移/字节级排查时用） */
  bodyLatin1: string
  /** 整个请求体的 fnv1a 摘要（字节级保真） */
  digest: string
  headers: Record<string, string>
}

export interface TestSite {
  url: string
  port: number
  log: () => { submits: Array<Record<string, unknown>>; uploads: TestSiteUpload[]; requests: string[]; notFound: string[] }
  close: () => Promise<void>
}

const PAGE = (title: string, body: string): string =>
  `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`

/**
 * 从 multipart 正文里取出文件名。
 *
 * 为什么不能直接 `body.toString('latin1')` 再正则：Chromium 提交表单时把文件名按 UTF-8 原样
 * 写进 `filename="..."`（不用 RFC 5987 的 filename*），latin1 解码会把每个字节变成一个字符，
 * 中文名就变成 `æ¥åæ ·æ¬` 这类乱码。这里在 latin1 视图（= 逐字节）里定位引号，再按 UTF-8 解码。
 */
function multipartFilename(b: Buffer): string {
  const raw = b.toString('latin1')
  const star = /filename\*=UTF-8''([^;\r\n]*)/i.exec(raw)?.[1]
  if (star) return decodeURIComponent(star)
  const m = /filename="/.exec(raw)
  if (!m) return '(未解析到文件名)'
  const start = m.index + m[0].length
  const end = raw.indexOf('"', start)
  if (end < 0) return '(未解析到文件名)'
  return b.subarray(start, end).toString('utf8')
}

export async function startTestSite(): Promise<TestSite> {
  const submits: Array<Record<string, unknown>> = []
  const uploads: TestSiteUpload[] = []
  const requests: string[] = []
  const notFound: string[] = []

  const readBody = (req: http.IncomingMessage): Promise<Buffer> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => resolve(Buffer.concat(chunks)))
    })

  const server = http.createServer((req, res) => {
    const url = req.url || '/'
    requests.push(`${req.method} ${url}`)
    const json = (code: number, data: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(data))
    }

    if (url === '/__log') {
      json(200, { submits, uploads, requests, notFound })
      return
    }
    if (url.startsWith('/pixel.png')) {
      // 慢图片：默认 0ms，?d=800 时延迟 800ms 再回，用来验证全页截图会等图片加载完
      const delay = Number(new URL(url, 'http://127.0.0.1').searchParams.get('d') || 0) || 0
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/2wAAAABJRU5ErkJggg==', 'base64')
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(png.length) })
        res.end(png)
      }, delay)
      return
    }
    if (url === '/missing.json' || url === '/missing.css') {
      notFound.push(url)
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      return
    }
    if (url === '/api/submit' && req.method === 'POST') {
      void readBody(req).then((b) => {
        let data: Record<string, unknown> = {}
        try {
          data = JSON.parse(b.toString('utf8')) as Record<string, unknown>
        } catch {
          data = { raw: b.toString('utf8') }
        }
        submits.push(data)
        json(200, { ok: true, received: data, note: '服务端已收到表单' })
      })
      return
    }
    if (url === '/api/upload' && req.method === 'POST') {
      void readBody(req).then((b) => {
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v
        const name = multipartFilename(b)
        uploads.push({ name, size: b.length, bytes: b.length, body: b.toString('utf8'), bodyLatin1: b.toString('latin1'), digest: digest(b), headers })
        json(200, { ok: true, filename: name, bytes: b.length, digest: digest(b) })
      })
      return
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    switch (url.split('?')[0]) {
      case '/':
        res.end(
          PAGE(
            'live13 测试站',
            `<h1>live13 测试站</h1>
             <ul><li><a href="/wizard">三步向导</a></li><li><a href="/upload">文件上传</a></li>
             <li><a href="/react">受控输入</a></li><li><a href="/broken">故意坏掉的页面</a></li>
             <li><a id="blank-link" href="/wizard" target="_blank">在新标签打开</a></li></ul>
             <div id="home-marker">站首页已就绪</div>`,
          ),
        )
        return
      case '/wizard':
        res.end(
          PAGE(
            '三步向导',
            `<h1>住院登记向导</h1>
             <div id="step1">
               <label>患者姓名 <input id="w-name" placeholder="请输入姓名" /></label>
               <button id="w-next">下一步</button>
             </div>
             <div id="step2" style="display:none">
               <label>病区
                 <select id="w-ward"><option value="">请选择</option><option value="东区">东区</option><option value="西区">西区</option></select>
               </label>
               <label>备注 <textarea id="w-note" placeholder="备注"></textarea></label>
               <button id="w-back">上一步</button><button id="w-next2">下一步</button>
             </div>
             <div id="step3" style="display:none">
               <div id="w-summary">（未填写）</div>
               <label><input type="checkbox" id="w-confirm" /> 我确认信息无误</label>
               <button id="w-submit">提交</button>
             </div>
             <div id="w-result" data-state="idle">尚未提交</div>
             <script>
               var S = { name: '', ward: '', note: '' };
               var show = function (n) {
                 for (var i = 1; i <= 3; i++) document.getElementById('step' + i).style.display = (i === n ? '' : 'none');
               };
               document.getElementById('w-next').onclick = function () {
                 S.name = document.getElementById('w-name').value.trim();
                 if (!S.name) { document.getElementById('w-result').textContent = '请先填姓名'; return; }
                 show(2);
               };
               document.getElementById('w-next2').onclick = function () {
                 S.ward = document.getElementById('w-ward').value;
                 S.note = document.getElementById('w-note').value;
                 if (!S.ward) { document.getElementById('w-result').textContent = '请选择病区'; return; }
                 document.getElementById('w-summary').textContent = S.name + ' / ' + S.ward + ' / ' + S.note;
                 show(3);
               };
               document.getElementById('w-back').onclick = function () { show(1); };
               document.getElementById('w-submit').onclick = function () {
                 var out = document.getElementById('w-result');
                 if (!document.getElementById('w-confirm').checked) { out.textContent = '请先勾选确认'; return; }
                 var body = { name: S.name, ward: S.ward, note: S.note, step: 3 };
                 out.dataset.state = 'posting';
                 fetch('/api/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
                   .then(function (r) { return r.json(); })
                   .then(function (j) { out.dataset.state = 'done'; out.textContent = '提交成功：' + j.received.name + '/' + j.received.ward; })
                   .catch(function (e) { out.dataset.state = 'error'; out.textContent = '提交失败：' + e; });
               };
             </script>`,
          ),
        )
        return
      case '/upload':
        res.end(
          PAGE(
            '文件上传',
            `<h1>上传检查报告</h1>
             <form id="up-form" method="post" action="/api/upload" enctype="multipart/form-data">
               <label>报告文件 <input type="file" id="up-file" name="report" /></label>
               <label>送检科室 <input id="up-dept" name="dept" placeholder="科室" /></label>
               <button type="submit" id="up-submit">上传并送检</button>
             </form>
             <div id="up-result" data-state="idle">尚未上传</div>
             <script>
               document.getElementById('up-form').addEventListener('submit', function (ev) {
                 ev.preventDefault();
                 var out = document.getElementById('up-result');
                 var f = document.getElementById('up-file').files[0];
                 if (!f) { out.textContent = '请先选择文件'; return; }
                 var fd = new FormData();
                 fd.append('report', f, f.name);
                 fd.append('dept', document.getElementById('up-dept').value);
                 out.dataset.state = 'posting';
                 fetch('/api/upload', { method: 'POST', body: fd })
                   .then(function (r) { return r.json(); })
                   .then(function (j) { out.dataset.state = 'done'; out.textContent = '上传成功：' + j.filename + ' (' + j.bytes + ' 字节)'; })
                   .catch(function (e) { out.dataset.state = 'error'; out.textContent = '上传失败：' + e; });
               });
             </script>`,
          ),
        )
        return
      case '/react':
        res.end(
          PAGE(
            '受控输入',
            `<h1>受控输入页</h1>
             <div class="field"><input id="c-name" placeholder="受控输入" /></div>
             <div>当前值：<span id="c-echo">（空）</span></div>
             <script>
               // 模拟 React 受控组件：value 被自定义存取器接管（外部直接 el.value = x 无效），
               // 只有「原生 setter 改内部值 + input 事件」这条路才能把值送进组件状态。
               var input = document.getElementById('c-name');
               var echo = document.getElementById('c-echo');
               var proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
               var state = '';
               Object.defineProperty(input, 'value', {
                 get: function () { return state; },
                 set: function () { /* 受控：忽略外部直接赋值 */ }
               });
               input.addEventListener('input', function () {
                 state = proto.get.call(input);
                 echo.textContent = state || '（空）';
               });
             </script>`,
          ),
        )
        return
      case '/broken':
        res.end(
          PAGE(
            '故意坏掉的页面',
            `<h1>故意坏掉的页面</h1>
             <div id="ok-part">这半页是好的</div>
             <img src="/missing.json" alt="该图会 404" />
             <script>
               console.error('BROKEN_MARKER 业务代码抛出的错误日志');
               setTimeout(function () { throw new Error('BROKEN_THROW 未捕获异常：结算金额为负'); }, 200);
             </script>`,
          ),
        )
        return
      case '/slow':
        res.end(
          PAGE(
            '慢页面',
            `<h1>慢页面</h1><div id="slow-out">加载中…</div>
             <script>setTimeout(function () { document.getElementById('slow-out').textContent = 'SLOW_DONE 内容已就绪'; }, 3000);</script>`,
          ),
        )
        return
      /**
       * 自报视口的页面（分辨率/截图尺寸契约的靶子）。
       * 关键：尺寸由**页面自己**读 window.innerWidth/innerHeight 报出来——这是「视口真的变了」的
       * 页面侧证据，比只看 DOM 样式或工具返回值可信（工具返回值也可能是渲染层自己算的）。
       */
      case '/viewport': {
        const q = new URL(url, 'http://127.0.0.1').searchParams
        const tall = Math.max(0, Number(q.get('h') || 0) || 0)
        const lazy = Math.max(0, Number(q.get('lazy') || 0) || 0)
        const lazyImgs = Array.from({ length: lazy }, (_, i) => `<img id="lz-${i}" data-src="/pixel.png?d=800" style="width:120px;height:90px;display:block" alt="懒加载图 ${i}" />`).join('')
        res.end(
          PAGE(
            '视口自报页',
            `<style>html,body{margin:0;padding:0}</style>
             <div id="vp-topband" style="height:40px;background:#c81e1e"></div>
             <h1>视口自报页</h1>
             <div id="vp-size">?</div>
             <div id="vp-dpr">?</div>
             <div id="vp-scroll">?</div>
             <div id="lazy-status">lazy:0/${lazy}</div>
             <div id="vp-tall" style="height:${tall}px"></div>
             <div id="vp-bottom">BOTTOM_MARKER_VIEWPORT</div>
             ${lazyImgs}
             <div id="vp-botband" style="height:40px;background:#1e50c8"></div>
             <script>
               var total = ${lazy};
               var done = 0;
               function report() {
                 document.getElementById('vp-size').textContent = window.innerWidth + 'x' + window.innerHeight;
                 document.getElementById('vp-dpr').textContent = 'dpr:' + (window.devicePixelRatio || 1);
                 document.getElementById('vp-scroll').textContent = 'scroll:' + document.documentElement.scrollHeight;
               }
               report();
               window.addEventListener('resize', report);
               // 懒加载：进视口才把 data-src 换到 src（公众号文章就是这套），图片本身还要 800ms 才回来
               var io = new IntersectionObserver(function (entries) {
                 entries.forEach(function (en) {
                   if (!en.isIntersecting) return;
                   var img = en.target;
                   io.unobserve(img);
                   img.onload = function () {
                     done += 1;
                     document.getElementById('lazy-status').textContent = 'lazy:' + done + '/' + total;
                     report();
                   };
                   img.src = img.getAttribute('data-src');
                 });
               });
               Array.prototype.forEach.call(document.querySelectorAll('img[data-src]'), function (img) { io.observe(img); });
             </script>`,
          ),
        )
        return
      }
      default:
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
        res.end(PAGE('404', '<h1>404 页面不存在</h1>'))
    }
  })

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    log: () => ({ submits, uploads, requests, notFound }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

/** 便宜的内容摘要（只为「两次上传一致」这类断言，不做密码学用途） */
function digest(b: Buffer): string {
  let h = 2166136261
  for (const byte of b) {
    h ^= byte
    h = Math.imul(h, 16777619) >>> 0
  }
  return `fnv1a:${h.toString(16)}:${b.length}`
}
