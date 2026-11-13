import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { closeSync, openSync } from 'node:fs'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const backendRoot = path.join(repoRoot, 'backend')
const frontendRoot = path.join(repoRoot, 'frontend')
const args = new Set(process.argv.slice(2))
if (args.has('--help')) {
  console.log('用法：node scripts/test-e2e.mjs [--audit] [--crash] [--keep-server] [--port 18923]')
  process.exit(0)
}
const audit = args.has('--audit')
const crash = args.has('--crash')
const keepServer = args.has('--keep-server')
const portIndex = process.argv.indexOf('--port')
const requestedPort = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 0
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const go = process.platform === 'win32' ? 'go.exe' : 'go'
const node = process.execPath
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
const coverVideo = Buffer.from('GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAJTEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEyTbuMU6uEHFO7a1OsggI97AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjMuMS4xMDFXQYxMYXZmNjMuMS4xMDFEiYhAn0AAAAAAABZUrmvXrgEAAAAAAABO14EBc8WIAN7+EvCpIL6cgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QdzWUA4JCwgRC6gRCagQJVsIRVuYEBVe6BAOwBAAAAAAAAAgAAElTDZ/pzc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYzLjEuMTAxc3PVY8CLY8WIAN7+EvCpIL5nyKBFo4dFTkNPREVSRIeTTGF2YzYzLjEuMTAxIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDIuMDAwMDAwMDAwAB9DtnVAhueBAKO8gQAAgLACAJ0BKhAAEAAARwiFhYiFhIgCAgJ1qgP4Agz9KAD+/00S//xYV/FhX8WFf/FhX/z8zu3F/OYAo5WBAfQAsQEAARAQABgAGFgv9AAIAACjlYED6ACxAQABEBAAGAAYWC/0AAgAAKOVgQXcALEBAAEQEAAYABhYL/QACAAAHFO7a5G7j7OBALeK94EB8YIBsfCBAw==', 'base64')
const keyboardVideo = Buffer.from('GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAVnEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEyTbuMU6uEHFO7a1OsggVR7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjMuMS4xMDFXQYxMYXZmNjMuMS4xMDFEiYhA04gAAAAAABZUrmvXrgEAAAAAAABO14EBc8WIOcx4BAve1WucgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4Q7msoA4JCwgRC6gRCagQJVsIRVuYEBVe6BAOwBAAAAAAAAAgAAElTDZ/pzc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYzLjEuMTAxc3PVY8CLY8WIOcx4BAve1WtnyKBFo4dFTkNPREVSRIeTTGF2YzYzLjEuMTAxIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MjAuMDAwMDAwMDAwAB9DtnVBGeeBAKO9gQAAgLACAJ0BKhAAEAAARwiFhYiZhIgCAgJ1qgP4Agz9+wD+/00S//xKp/Eqn8Sqf/Eqn/0Yfww/hh/eEKOpgQPoALEBAAUQrAAYADA/9AwA7wD+8mav/XAfnAfnAfzLeB4fh4fhugCjqYEH0ACxAQAFEKwAGAAwP/QMAO8A/vJmr/1wH5wH5wH8y3geH4eH4boAo6mBC7gAsQEABRCsABgAMD/0DADvAP7yZq/9cB+cB+cB/Mt4Hh+Hh+G6AKOpgQ+gALEBAAUQrAAYADA/9AwA7wD+8mav/XAfnAfnAfzLeB4fh4fhugCjqYETiACxAQAFEKwAGAAwP/QMAO8A/vJmr/1wH5wH5wH8y3geH4eH4boAH0O2dUEL54IXcKOpgQAAALEBAAUQrAAYADA/9AwA7wD+8mav/XAfnAfnAfzLeB4fh4fhugCjroED6ACxAQAFEBAUYADA/9AwA7wA/v9NEv/8SqfxKp/Eqn/xKp/9GH8MP4Yf3hCjqYEH0ACxAQAFEKwAGAAwP/QMAO8A/vJmr/1wH5wH5wH8y3geH4eH4boAo6mBC7gAsQEABRCsABgAMD/0DADvAP7yZq/9cB+cB+cB/Mt4Hh+Hh+G6AKOpgQ+gALEBAAUQrAAYADA/9AwA7wD+8mav/XAfnAfnAfzLeB4fh4fhugCjqYETiACxAQAFEKwAGAAwP/QMAO8A/vJmr/1wH5wH5wH8y3geH4eH4boAH0O2dUEL54Iu4KOpgQAAALEBAAUQrAAYADA/9AwA7wD+8mav/XAfnAfnAfzLeB4fh4fhugCjqYED6ACxAQAFEKwAGAAwP/QMAO8A/vJmr/1wH5wH5wH8y3geH4eH4boAo66BB9AAsQEABRAQFGAAwP/QMAO8AP7/TRL//Eqn8SqfxKp/8Sqf/Rh/DD+GH94Qo6mBC7gAsQEABRCsABgAMD/0DADvAP7yZq/9cB+cB+cB/Mt4Hh+Hh+G6AKOpgQ+gALEBAAUQrAAYADA/9AwA7wD+8mav/XAfnAfnAfzLeB4fh4fhugCjqYETiACxAQAFEKwAGAAwP/QMAO8A/vJmr/1wH5wH5wH8y3geH4eH4boAH0O2ddrngkZQo6mBAAAAsQEABRCsABgAMD/0DADvAP7yZq/9cB+cB+cB/Mt4Hh+Hh+G6AKOpgQPoALEBAAUQrAAYADA/9AwA7wD+8mav/XAfnAfnAfzLeB4fh4fhugAcU7trkbuPs4EAt4r3gQHxggGx8IED', 'base64')

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(command + ' exited with ' + result.status)
}

async function writeFixture(root, relative, data = png) {
  const destination = path.join(root, relative)
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, data)
  return destination
}

async function makeFixtures(root) {
  const media = path.join(root, 'media')
  const comic = path.join(root, 'media-comic')
  await mkdir(media, { recursive: true })
  await mkdir(comic, { recursive: true })

  for (let i = 1; i <= 3; i++) await writeFixture(media, 'sample-album/page-' + i + '.png')
  await writeFixture(media, 'sample-format/photo.heic', Buffer.from('not a decodable image'))
  await writeFixture(media, 'sample-broken/broken.jpg', Buffer.from('not a decodable image'))

  for (let i = 1; i <= 2; i++) await writeFixture(media, '2024年/page-' + i + '.png')
  for (let i = 1; i <= 520; i++) {
    await writeFixture(media, '2024年照片墙/page-' + String(i).padStart(4, '0') + '.png')
  }
  const today = new Date()
  const lastYear = today.getFullYear() - 1
  const month = String(today.getMonth() + 1).padStart(2, '0')
  const day = String(today.getDate()).padStart(2, '0')
  await writeFixture(media, 'zz-当年今日/IMG_' + lastYear + month + day + '_120000.png')

  const samples = [
    { name: 'A', modified: '2023-01-01T00:00:00Z', mediaModified: '2025-01-01T00:00:00Z' },
    { name: 'M', modified: '2024-01-01T00:00:00Z', mediaModified: '2000-01-01T00:00:00Z' },
    { name: 'Z', modified: '2022-01-01T00:00:00Z', mediaModified: '2030-01-01T00:00:00Z' },
  ]
  const taggedPrefix = 'zz-[测试][空 格][C++][100%][字面%20][字面%2F][字面%25] tagged-'
  for (const [rootName, rootPath] of [['media', media], ['media-comic', comic]]) {
    const parents = [rootPath, path.join(rootPath, 'zz-sort-collection')]
    for (const parent of parents) {
      for (const sample of samples) {
        const album = path.join(parent, taggedPrefix + sample.name)
        const image = await writeFixture(root, path.relative(root, path.join(album, 'page.png')))
        await utimes(image, new Date(sample.mediaModified), new Date(sample.mediaModified))
        await utimes(album, new Date(sample.modified), new Date(sample.modified))
      }
    }
  }

  const capture = await writeFixture(media, 'zz-capture-date/IMG_20240115_120000.png')
  await utimes(capture, new Date('2019-05-05T00:00:00Z'), new Date('2019-05-05T00:00:00Z'))
  await utimes(path.dirname(capture), new Date('2019-05-05T00:00:00Z'), new Date('2019-05-05T00:00:00Z'))

  for (let i = 1; i <= 3; i++) await writeFixture(comic, 'sample-comic/page-' + i + '.png')
  const collection = path.join(comic, 'zz-scroll-collection')
  for (const parent of [comic, collection]) {
    for (let i = 1; i <= 108; i++) {
      await writeFixture(root, path.relative(root, path.join(parent, 'zz-[滚动回归] long-list-' + String(i).padStart(3, '0'), 'page.png')))
    }
  }

  for (const kind of ['images', 'mixed', 'videos']) {
    const extension = kind === 'videos' ? 'mp4' : 'png'
    for (let i = 1; i <= 405; i++) {
      await writeFixture(media, 'sample-paged-' + kind + '/page-' + i + '.' + extension)
    }
    if (kind === 'mixed') await writeFixture(media, 'sample-paged-mixed/zz-video.mp4')
  }

  await writeFixture(media, 'sample-video-cover/clip.webm', coverVideo)
  await writeFixture(media, 'sample-mixed-cover/clip.webm', coverVideo)
  await writeFixture(media, 'sample-mixed-cover/page.png')
  await writeFixture(media, 'sample-mixed-cover/page-2.png')
  for (const suffix of ['A', 'B', 'C']) {
    await writeFixture(media, 'sample-video-shortcuts/clip-' + suffix + '.webm', keyboardVideo)
  }
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(requestedPort || 0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : requestedPort
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

async function waitForServer(child, baseUrl) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error('临时服务提前退出，退出码 ' + child.exitCode)
    try {
      const response = await fetch(baseUrl + '/api/health')
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('临时服务未能在 20 秒内启动')
}

function stopProcess(child) {
  if (!child || child.exitCode !== null) return Promise.resolve()
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    return once(killer, 'exit').then(() => undefined)
  }
  child.kill('SIGTERM')
  return Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ])
}

async function main() {
  const testRoot = keepServer
    ? await mkdtemp(path.join(tmpdir(), 'local-gallery-dev-e2e-'))
    : await mkdtemp(path.join(tmpdir(), 'local-gallery-e2e-'))
  await mkdir(testRoot, { recursive: true })
  const staticRoot = path.join(testRoot, 'frontend')
  const mediaRoot = path.join(testRoot, 'media')
  const comicRoot = path.join(testRoot, 'media-comic')
  const cacheRoot = path.join(testRoot, 'cache')
  const serverPath = path.join(testRoot, process.platform === 'win32' ? 'server.exe' : 'server')
  const configPath = path.join(testRoot, 'config.yaml')
  const basePort = requestedPort || await allocatePort()
  const baseUrl = 'http://127.0.0.1:' + basePort
  let server = null

  try {
    console.log('[1/4] 生成临时媒体并构建前后端...')
    await makeFixtures(testRoot)
    await mkdir(path.join(cacheRoot, 'state'), { recursive: true })
    await writeFile(path.join(cacheRoot, 'state', 'ai_jobs.json'), JSON.stringify({
      version: 1,
      jobs: [],
      queue: [],
      settings: {
        dailyEnabled: false,
        dailyTime: '03:00',
        dailyModules: ['metadata'],
        peopleEnabled: false,
      },
    }))
    const yamlPath = (value) => value.replaceAll('\\', '/')
    await writeFile(configPath, [
      'mediaRoots:',
      '  - path: "' + yamlPath(mediaRoot) + '"',
      '    kind: photo',
      '  - path: "' + yamlPath(comicRoot) + '"',
      '    kind: comic',
      '  - path: "' + yamlPath(mediaRoot + '-offline') + '"',
      '    kind: photo',
      'host: "127.0.0.1"',
      'port: ' + basePort,
      'cacheDir: "' + yamlPath(cacheRoot) + '"',
      'staticDir: "' + yamlPath(staticRoot) + '"',
      '',
    ].join('\n'))

    const resolvedStatic = path.resolve(staticRoot)
    if (path.dirname(resolvedStatic) !== path.resolve(testRoot)) {
      throw new Error('拒绝构建到当前测试目录之外的路径')
    }
    run(npm, ['run', 'build', '--', '--outDir', staticRoot, '--emptyOutDir'], { cwd: frontendRoot })
    run(go, ['build', '-o', serverPath, './cmd/server'], { cwd: backendRoot })

    console.log('[2/4] 启动临时服务...')
    const stdout = openSync(path.join(testRoot, 'server.stdout.log'), 'a')
    const stderr = openSync(path.join(testRoot, 'server.stderr.log'), 'a')
    server = spawn(serverPath, ['--config', configPath], {
      cwd: backendRoot,
      stdio: ['ignore', stdout, stderr],
      detached: keepServer,
    })
    closeSync(stdout)
    closeSync(stderr)
    if (keepServer) {
      server.unref()
      await waitForServer(server, baseUrl)
      console.log('临时服务已启动：' + baseUrl + '（PID ' + server.pid + '）')
      console.log('测试目录：' + testRoot)
      server = null
      return
    }
    await waitForServer(server, baseUrl)

    console.log('[3/4] 运行 Playwright...')
    const e2eEnv = { ...process.env, PLAYWRIGHT_BASE_URL: baseUrl }
    run(npm, ['exec', '--', 'playwright', 'test'], { cwd: frontendRoot, env: e2eEnv })

    if (audit) {
      console.log('[3.5/4] 运行布局和对比度审计...')
      const auditEnv = { ...e2eEnv, LG_BASE: baseUrl }
      run(node, ['scripts/layout-audit.mjs'], { cwd: frontendRoot, env: auditEnv })
      run(node, ['scripts/contrast-audit.mjs'], { cwd: frontendRoot, env: auditEnv })
    }
    if (crash) {
      console.log('[3.6/4] 运行相册崩溃探针...')
      const crashEnv = { ...e2eEnv, LG_BASE: baseUrl, LG_CRASH_ALBUM: 'sample-paged-videos', LG_CRASH_VISITS: '10' }
      run(node, ['scripts/album-crash-probe.mjs'], { cwd: frontendRoot, env: crashEnv })
    }
  } finally {
    if (!keepServer) {
      console.log('[4/4] 清理临时服务和测试目录...')
      await stopProcess(server)
      if (testRoot.startsWith(path.join(tmpdir(), 'local-gallery-e2e-'))) {
        await rm(testRoot, { recursive: true, force: true })
      }
    }
  }
}

main().catch((error) => {
  console.error('[错误]', error?.stack ?? error)
  process.exitCode = 1
})
