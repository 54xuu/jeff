// 极简 WebDAV mock：MKCOL / PUT / GET / DELETE / PROPFIND（Depth 0/1），文件落在指定根目录
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

/**
 * @param {number} port
 * @param {string} rootDir
 * @returns {Promise<import('node:http').Server>}
 */
export function startMockWebdav(port, rootDir) {
  fs.mkdirSync(rootDir, { recursive: true })
  const server = http.createServer((req, res) => {
    let body = []
    req.on('data', (c) => body.push(c))
    req.on('end', () => {
      const data = Buffer.concat(body)
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
      const fsPath = path.join(rootDir, urlPath)
      if (urlPath.includes('..')) {
        res.writeHead(403)
        res.end()
        return
      }
      const method = (req.method || '').toUpperCase()
      if (process.env.DAV_LOG) console.error(`[dav] ${method} ${urlPath} Depth=${req.headers.depth || ''}`)
      if (method === 'MKCOL') {
        fs.mkdirSync(fsPath, { recursive: true })
        res.writeHead(201)
        res.end()
        return
      }
      if (method === 'PUT') {
        fs.mkdirSync(path.dirname(fsPath), { recursive: true })
        fs.writeFileSync(fsPath, data)
        res.writeHead(201)
        res.end()
        return
      }
      if (method === 'GET') {
        // 测试注入：rootDir/.dav-fail = { "agents.json": 500 } → 匹配后缀返回指定状态码
        const failFile = path.join(rootDir, '.dav-fail')
        if (fs.existsSync(failFile)) {
          try {
            const rules = JSON.parse(fs.readFileSync(failFile, 'utf8'))
            for (const [suffix, code] of Object.entries(rules)) {
              if (urlPath.endsWith(String(suffix))) {
                res.writeHead(Number(code) || 500)
                res.end('injected failure')
                return
              }
            }
          } catch {
            /* ignore bad fail file */
          }
        }
        if (fs.existsSync(fsPath) && fs.statSync(fsPath).isFile()) {
          const buf = fs.readFileSync(fsPath)
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length })
          res.end(buf)
        } else {
          res.writeHead(404)
          res.end('not found')
        }
        return
      }
      if (method === 'DELETE') {
        if (fs.existsSync(fsPath) && fs.statSync(fsPath).isFile()) {
          fs.rmSync(fsPath, { force: true })
          res.writeHead(204)
          res.end()
        } else {
          res.writeHead(404)
          res.end('not found')
        }
        return
      }
      if (method === 'PROPFIND') {
        // 测试注入：与 GET 共用 .dav-fail 规则（模拟服务端对含 index.html 的目录回 405 等怪癖）
        const failFile = path.join(rootDir, '.dav-fail')
        if (fs.existsSync(failFile)) {
          try {
            const rules = JSON.parse(fs.readFileSync(failFile, 'utf8'))
            for (const [suffix, code] of Object.entries(rules)) {
              if (urlPath.endsWith(String(suffix))) {
                res.writeHead(Number(code) || 500)
                res.end('injected failure')
                return
              }
            }
          } catch {
            /* ignore bad fail file */
          }
        }
        const depth = String(req.headers.depth || '0')
        if (!fs.existsSync(fsPath)) {
          res.writeHead(404)
          res.end()
          return
        }
        const st = fs.statSync(fsPath)
        const entries = []
        const emitEntry = (p, isDir, mtimeMs, size) => {
          const href = p.split('/').map((seg) => encodeURIComponent(seg)).join('/')
          entries.push(
            `<d:response><d:href>${href}${isDir ? '/' : ''}</d:href><d:propstat><d:prop>` +
              (isDir ? '<d:resourcetype><d:collection/></d:resourcetype>' : `<d:resourcetype/><d:getcontentlength>${size}</d:getcontentlength>`) +
              `<d:getlastmodified>${new Date(mtimeMs).toUTCString()}</d:getlastmodified>` +
              `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
          )
        }
        emitEntry(urlPath, st.isDirectory(), st.mtimeMs, st.size)
        if (st.isDirectory() && depth === '1') {
          for (const name of fs.readdirSync(fsPath)) {
            const child = path.join(fsPath, name)
            const cst = fs.statSync(child)
            emitEntry(`${urlPath.replace(/\/$/, '')}/${name}`, cst.isDirectory(), cst.mtimeMs, cst.size)
          }
        }
        const xml = `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${entries.join('')}</d:multistatus>`
        res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' })
        res.end(xml)
        return
      }
      res.writeHead(405)
      res.end()
    })
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}
