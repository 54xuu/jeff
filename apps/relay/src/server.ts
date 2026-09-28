import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import { WebSocketServer, type WebSocket } from 'ws'
import { Hub, type HubOptions, type RelaySocket } from './hub.js'
import { Store } from './store.js'

export interface RelayListenOptions extends HubOptions {
  port?: number
  host?: string
  dataFile: string
  tls?: { cert: Buffer; key: Buffer }
  maxPayload?: number
}

export interface RunningRelay {
  port: number
  url: string
  close: () => Promise<void>
}

export function startRelay(opts: RelayListenOptions): Promise<RunningRelay> {
  const store = new Store(opts.dataFile)
  const hub = new Hub(store, opts)
  const server = opts.tls ? https.createServer({ cert: opts.tls.cert, key: opts.tls.key }) : http.createServer()
  server.on('request', (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    res.writeHead(404)
    res.end()
  })
  const wss = new WebSocketServer({ server, maxPayload: opts.maxPayload ?? 4 * 1024 * 1024 })
  wss.on('connection', (ws: WebSocket) => {
    const sock: RelaySocket = {
      send: (text) => {
        if (ws.readyState === ws.OPEN) ws.send(text)
      },
      close: () => ws.close(),
    }
    hub.connect(sock)
    ws.on('message', (data) => hub.message(sock, data.toString()))
    ws.on('close', () => hub.disconnect(sock))
  })
  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? 0
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const addr = server.address()
      const actual = typeof addr === 'object' && addr ? addr.port : port
      const scheme = opts.tls ? 'wss' : 'ws'
      resolve({
        port: actual,
        url: `${scheme}://${host}:${actual}`,
        close: () =>
          new Promise((done) => {
            let finished = false
            const finish = () => {
              if (finished) return
              finished = true
              try {
                store.close()
              } catch {
                /* 已经关过 */
              }
              server.unref()
              done()
            }
            const timer = setTimeout(() => {
              for (const client of wss.clients) client.terminate()
              server.closeAllConnections()
              finish()
            }, 1500)
            hub.stop()
            for (const client of wss.clients) client.close()
            wss.close(() => {
              server.close(() => {
                clearTimeout(timer)
                finish()
              })
            })
          }),
      })
    })
  })
}

function readRequired(path: string | undefined, name: string): Buffer {
  if (!path || !fs.existsSync(path)) throw new Error(`缺少 ${name}：${path || '(未设置)'}`)
  return fs.readFileSync(path)
}

/** 进程入口。测试不走这里。 */
async function main(): Promise<void> {
  const cert = readRequired(process.env.TLS_CERT, 'TLS_CERT')
  const key = readRequired(process.env.TLS_KEY, 'TLS_KEY')
  const dataFile = process.env.DATA_DIR ? `${process.env.DATA_DIR.replace(/\/$/, '')}/relay.db` : '/data/relay.db'
  fs.mkdirSync(dataFile.replace(/\/[^/]+$/, ''), { recursive: true })
  const running = await startRelay({
    host: '0.0.0.0',
    port: Number(process.env.PORT || 9443),
    dataFile,
    tls: { cert, key },
  })
  console.log(`[jeff-relay] listening ${running.url}`)
}

const entry = process.argv[1] || ''
if (entry.endsWith('server.js') || entry.endsWith('server.cjs') || entry.endsWith('server.ts')) {
  main().catch((err) => {
    console.error('[jeff-relay] 启动失败', err)
    process.exit(1)
  })
}
