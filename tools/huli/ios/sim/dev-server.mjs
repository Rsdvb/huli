// A dev server on the runner's loopback for the 90-dev-preview flow (run.sh starts it): a page
// whose script, a fetch and a WebSocket, as a dev server's HMR, each say on the page that they got
// through, with what Host and Origin the server saw, which the phone's preview rewrites to
// localhost. Listens on 127.0.0.1 alone, as `vite` does by default. Huli's own; see
// tools/huli/README.md.

import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

const PORT = 41730

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>纸鸢预览</title>
<style>body { font: 18px -apple-system, system-ui, sans-serif; padding: 24px; }</style>
</head>
<body>
<h1>纸鸢预览正常</h1>
<p id="script">脚本：没有加载</p>
<p id="api">接口：等待中</p>
<p id="hmr">HMR：连接中</p>
<script src="/src/main.js"></script>
</body>
</html>
`

const SCRIPT = `
document.getElementById('script').textContent = '脚本：已加载'
fetch('/api/ping').then((r) => r.text()).then((t) => {
  document.getElementById('api').textContent = '接口：' + t
}, (e) => {
  document.getElementById('api').textContent = '接口：失败 ' + e
})
const ws = new WebSocket('ws://' + location.host + '/hmr')
ws.onmessage = (event) => {
  document.getElementById('hmr').textContent = 'HMR：已连接 ' + event.data
}
ws.onerror = () => {
  document.getElementById('hmr').textContent = 'HMR：失败'
}
`

const server = createServer((req, res) => {
  console.log(req.method, req.url, req.headers.host, req.headers.origin ?? '-')
  if (req.url === '/src/main.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
    return void res.end(SCRIPT)
  }
  if (req.url === '/api/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    return void res.end(`pong ${req.headers.host}`)
  }
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
    return void res.end(PAGE)
  }
  res.writeHead(404)
  res.end()
})
const sockets = new WebSocketServer({ server, path: '/hmr' })
sockets.on('connection', (ws, req) => {
  console.log('ws', req.headers.host, req.headers.origin ?? '-')
  ws.send(`${req.headers.host} ${req.headers.origin ?? ''}`.trim())
})
server.listen(PORT, '127.0.0.1', () => console.log(`dev server on 127.0.0.1:${PORT}`))
