import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'

const fileReadable = path => {
  try {
    accessSync(path, constants.R_OK)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw new Error(`Rooms cannot read ${path} as uid ${process.getuid()}`, { cause: error })
  }
}

async function healthCheck() {
  const signal = AbortSignal.timeout(2500)
  try {
    const [web, media] = await Promise.all([
      fetch('http://127.0.0.1:8080/health', { signal }),
      fetch('http://127.0.0.1:8889/', { signal }),
    ])
    await Promise.all([web.body?.cancel(), media.body?.cancel()])
    if (!web.ok || media.status >= 500) process.exitCode = 1
  } catch {
    process.exitCode = 1
  }
}

function serve() {
  const origin = new URL(process.env.PUBLIC_ORIGIN)
  const local = origin.protocol === 'http:'
  const port = process.env.VOICE_ICE_PORT || '8189'
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) {
    throw new Error('VOICE_ICE_PORT must be a TCP/UDP port from 1 to 65535.')
  }
  const certificate = !local && fileReadable('/tls/fullchain.pem')
  const key = !local && fileReadable('/tls/privkey.pem')
  if (certificate !== key || (!local && process.env.STREAM_INGEST_BASE && !certificate)) {
    throw new Error('RTMPS ingest requires a readable /tls/fullchain.pem and /tls/privkey.pem.')
  }
  const setup = spawnSync(process.execPath, ['/app/bootstrap.mjs', '--ensure-setup-key'], { stdio: 'inherit' })
  if (setup.error || setup.status !== 0) throw new Error('Rooms could not initialize first-run setup.', { cause: setup.error })

  const children = new Set()
  let stopping = false
  function stop(code) {
    if (stopping) return
    stopping = true
    process.exitCode = code
    for (const child of children) child.kill('SIGTERM')
    setTimeout(() => {
      for (const child of children) child.kill('SIGKILL')
    }, 9000).unref()
  }
  function start(name, command, arguments_, environment = {}) {
    const child = spawn(command, arguments_, { env: { ...process.env, ...environment }, stdio: 'inherit' })
    children.add(child)
    child.once('error', error => {
      children.delete(child)
      console.error(`Rooms could not start ${name}: ${error.message}`)
      stop(1)
    })
    child.once('exit', (code, signal) => {
      children.delete(child)
      if (stopping) return
      console.error(`Rooms process ${name} exited (${signal || code}).`)
      stop(1)
    })
  }
  process.on('SIGTERM', () => stop(0))
  process.on('SIGINT', () => stop(0))

  start('server', process.execPath, ['/app/server.mjs'], {
    HOST: '127.0.0.1',
    PORT: '8082',
    AUTH_HOST: '127.0.0.1',
    AUTH_PORT: '8081',
    MEDIAMTX_API_URL: 'http://127.0.0.1:9997',
    MEDIAMTX_WEBRTC_URL: 'http://127.0.0.1:8889',
  })
  start('MediaMTX', '/usr/local/bin/mediamtx', ['/etc/rooms/mediamtx.yml'], {
    MTX_AUTHHTTPADDRESS: 'http://127.0.0.1:8081/internal/media-auth',
    MTX_APIADDRESS: '127.0.0.1:9997',
    MTX_HLSADDRESS: '127.0.0.1:8888',
    MTX_WEBRTCADDRESS: '127.0.0.1:8889',
    MTX_WEBRTCADDITIONALHOSTS: process.env.VOICE_ICE_HOST || origin.hostname.replace(/^\[|\]$/g, ''),
    MTX_WEBRTCLOCALUDPADDRESS: ':' + port,
    MTX_WEBRTCLOCALTCPADDRESS: ':' + port,
    MTX_RTMP: local || certificate ? 'true' : 'false',
    MTX_RTMPENCRYPTION: local ? 'no' : 'strict',
  })
  start('NGINX', '/usr/sbin/nginx', ['-g', 'daemon off;'])
}

if (process.argv[2] === '--health') await healthCheck()
else serve()
