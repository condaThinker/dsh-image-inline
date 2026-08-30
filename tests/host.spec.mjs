// Host-half unit tests for dsh-image-inline (node --test).
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _internal as internal } from '../dsh/index.js'

/** A minimal valid 1x1 PNG (transparent). */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

/** Default resolved config used by most tests. */
function defaultConfig(overrides = {}) {
  return { ...internal.DEFAULTS, ...overrides }
}

/** Build a fake tool execution context. */
function fakeExec(cwd = '/ws') {
  return {
    agent: { session: { header: { cwd } } },
    signal: new AbortController().signal,
  }
}

/** Build a fake plugin ctx exposing fs + attachments services. */
function fakeCtx({ saveImageRef, saveImageError, fsImpl } = {}) {
  const attachments = {
    saveImage: async (input) => {
      if (saveImageError) throw saveImageError
      return saveImageRef ?? {
        attachmentId: 'sha256:' + 'a'.repeat(64),
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 1,
        height: 1,
        name: input.name,
      }
    },
  }
  const fs = fsImpl ?? {
    resolve: async (path, opts) => ({ path, displayPath: path }),
    stat: async (target) => ({ type: 'file', size: PNG_1X1.byteLength, version: 1 }),
    readBytes: async (target) => PNG_1X1,
  }
  const emitted = []
  return {
    get: (name) => (name === 'attachments' ? attachments : name === 'fs' ? fs : undefined),
    emit: (event, ...args) => { emitted.push([event, ...args]) },
    emitted,
  }
}

describe('mediaTypeForPath', () => {
  it('maps supported extensions to media types', () => {
    const config = defaultConfig()
    assert.equal(internal.mediaTypeForPath('/a/b.png', config), 'image/png')
    assert.equal(internal.mediaTypeForPath('/a/b.jpg', config), 'image/jpeg')
    assert.equal(internal.mediaTypeForPath('/a/b.jpeg', config), 'image/jpeg')
    assert.equal(internal.mediaTypeForPath('/a/b.webp', config), 'image/webp')
    assert.equal(internal.mediaTypeForPath('/a/b.gif', config), 'image/gif')
    assert.equal(internal.mediaTypeForPath('/a/b.PNG', config), 'image/png')
  })

  it('rejects unknown extensions', () => {
    assert.equal(internal.mediaTypeForPath('/a/b.txt', defaultConfig()), undefined)
    assert.equal(internal.mediaTypeForPath('/a/b', defaultConfig()), undefined)
  })

  it('honors the configured mediaTypes whitelist', () => {
    const config = defaultConfig({ mediaTypes: ['image/png'] })
    assert.equal(internal.mediaTypeForPath('/a/b.png', config), 'image/png')
    assert.equal(internal.mediaTypeForPath('/a/b.webp', config), undefined)
  })
})

describe('formatShowImageOutput', () => {
  it('is text-only and carries path + metadata summary', () => {
    const text = internal.formatShowImageOutput('/ws/x.png', {
      mediaType: 'image/png', width: 1920, height: 1200, bytes: 12345,
    })
    assert.match(text, /<path>\/ws\/x\.png<\/path>/)
    assert.match(text, /1920x1200 px/)
    assert.match(text, /12345 bytes/)
  })
})

describe('attachmentIdFromPath', () => {
  it('parses a valid content-addressed id', () => {
    const id = 'sha256:' + 'b'.repeat(64)
    assert.equal(internal.attachmentIdFromPath(`/plugin/show-image/${id}`), id)
  })

  it('rejects malformed ids and unrelated paths', () => {
    assert.equal(internal.attachmentIdFromPath('/plugin/show-image/not-an-id'), null)
    assert.equal(internal.attachmentIdFromPath('/plugin/show-image/sha256:xyz'), null)
    assert.equal(internal.attachmentIdFromPath('/plugin/show-image/'), null)
    assert.equal(internal.attachmentIdFromPath('/plugin/show-image'), null)
    assert.equal(internal.attachmentIdFromPath('/other/path'), null)
  })
})

describe('contentTypeFor', () => {
  it('maps supported media types', () => {
    assert.equal(internal.contentTypeFor('image/png'), 'image/png')
    assert.equal(internal.contentTypeFor('image/webp'), 'image/webp')
  })
})

describe('assertConfig', () => {
  it('accepts valid config', () => {
    assert.doesNotThrow(() => internal.assertConfig(defaultConfig()))
  })
  it('rejects bad byte/pixel limits', () => {
    assert.throws(() => internal.assertConfig(defaultConfig({ maxImageBytes: 0 })))
    assert.throws(() => internal.assertConfig(defaultConfig({ maxImagePixels: -1 })))
    assert.throws(() => internal.assertConfig(defaultConfig({ mediaTypes: [] })))
    assert.throws(() => internal.assertConfig(defaultConfig({ mediaTypes: ['image/tiff'] })))
  })
})

describe('registry', () => {
  let dir
  before(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-image-inline-test-')) })
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('round-trips entries through atomic writes', async () => {
    const file = join(dir, 'registry.json')
    await internal.updateRegistry(file, () => ({ 'sha256:aaa': { attachmentId: 'sha256:aaa', mediaType: 'image/png', bytes: 4, width: 2, height: 2 } }))
    await internal.updateRegistry(file, (entries) => ({ ...entries, 'sha256:bbb': { attachmentId: 'sha256:bbb', mediaType: 'image/jpeg', bytes: 8, width: 4, height: 2 } }))
    const read = internal.readRegistry(file)
    assert.equal(read['sha256:aaa'].mediaType, 'image/png')
    assert.equal(read['sha256:bbb'].bytes, 8)
  })

  it('returns an empty registry when missing', () => {
    assert.deepEqual(internal.readRegistry(join(dir, 'missing.json')), {})
  })

  it('tolerates a torn tail', () => {
    const file = join(dir, 'torn.json')
    writeFileSync(file, '{"sha256:aaa": {"attachmentId": "sha256:aaa"')
    assert.deepEqual(internal.readRegistry(file), {})
  })
})

describe('show_image tool (integration through the raw definition)', () => {
  // Wire the real apply() with a stub ctx: captures tools.register and the
  // inject callbacks, then returns the registered tool definition.
  async function mountTool({ config, saveImageRef, saveImageError, fsImpl } = {}) {
    const { apply } = await import('../dsh/index.js')
    const registrations = []
    const injectCalls = []
    const base = fakeCtx({ saveImageRef, saveImageError, fsImpl })
    const ctx = {
      get: (n) => base.get(n),
      inject: (names, fn) => { injectCalls.push([names, fn]) },
    }
    apply(ctx, defaultConfig(config))
    const scope = { ...ctx, tools: { register: (def) => { registrations.push(def); return () => {} } } }
    injectCalls[0][1](scope)
    return registrations[0]
  }

  it('apply registers the tool when attachments mount', async () => {
    const { apply } = await import('../dsh/index.js')
    const registrations = []
    const injectCalls = []
    const ctx = {
      get: () => undefined,
      inject: (names, fn) => { injectCalls.push([names, fn]) },
    }
    apply(ctx, defaultConfig())
    assert.deepEqual(injectCalls.map(([names]) => names), [['attachments'], ['webServer']])
    // Fire the attachments injection with a stubbed scoped ctx.
    const scope = { ...ctx, tools: { register: (def) => { registrations.push(def); return () => {} } } }
    injectCalls[0][1](scope)
    assert.equal(registrations.length, 1)
    assert.equal(registrations[0].name, 'show_image')
    assert.equal(typeof registrations[0].execute, 'function')
    assert.equal(typeof registrations[0].output.render, 'function')
    assert.equal(typeof registrations[0].output.presentationMeta, 'function')
    assert.equal(typeof registrations[0].isConcurrencySafe, 'function')
  })

  // Regression guard for the "cannot get property webServer without inject"
  // incident: the routes must be registered on the INJECTED scope (the scope
  // carries webServer), never on the outer ctx — Cordis forbids reading an
  // injected service as a property of an uninjected context, and the outer
  // ctx here intentionally has NO webServer property.
  it('registers both image routes on the injected webServer scope', async () => {
    const { apply } = await import('../dsh/index.js')
    const injectCalls = []
    const routeRegistrations = []
    const ctx = {
      get: () => undefined,
      inject: (names, fn) => { injectCalls.push([names, fn]) },
    }
    apply(ctx, defaultConfig())
    // The webServer inject callback must fire with a scope that owns
    // webServer; the effect wrapper receives the disposer.
    const capturedDisposers = []
    const webScope = {
      ...ctx,
      webServer: {
        register: (route) => {
          routeRegistrations.push(route)
          return () => 'disposed'
        },
      },
      effect: (fn) => { capturedDisposers.push(fn()) },
    }
    injectCalls[1][1](webScope)
    assert.equal(routeRegistrations.length, 2)
    assert.equal(routeRegistrations[0].kind, 'prefix')
    assert.equal(routeRegistrations[0].path, '/plugin/show-image')
    assert.equal(routeRegistrations[1].kind, 'prefix')
    assert.equal(routeRegistrations[1].path, '/plugin/show-image-by-path')
    // effect holds the register disposers; invoking them must dispose the routes.
    assert.equal(capturedDisposers.length, 2)
    assert.ok(capturedDisposers.every((disposer) => typeof disposer === 'function'))
    assert.ok(capturedDisposers.every((disposer) => disposer() === 'disposed'))
  })

  it('returns text-only content and a flat canonical value', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-image-inline-exec-'))
    // DSH_HOME must be set before apply() resolves the registry path.
    process.env.DSH_HOME = dir
    const tool = await mountTool()

    const result = await tool.execute({ path: '/ws/x.png' }, fakeExec())
    assert.equal(result.path, '/ws/x.png')
    assert.match(String(result.attachmentId), /^sha256:[0-9a-f]{64}$/)
    assert.equal(typeof result.width, 'number')
    assert.equal(typeof result.height, 'number')

    const content = tool.output.render({ path: '/ws/x.png' }, result)
    assert.ok(Array.isArray(content))
    assert.ok(content.length >= 1)
    assert.ok(content.every((block) => block.type === 'text'), 'render must be text-only (no image block)')

    const meta = tool.output.presentationMeta({ path: '/ws/x.png' }, result)
    assert.equal(meta.attachmentId, result.attachmentId)
    assert.equal(meta.mediaType, result.mediaType)
    assert.equal(meta.width, result.width)

    // Registry was persisted so the HTTP route can serve the image later.
    assert.ok(existsSync(join(dir, 'plugins', 'dsh-image-inline', 'registry.json')))
    delete process.env.DSH_HOME
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses unknown extensions', async () => {
    const tool = await mountTool()
    await assert.rejects(() => tool.execute({ path: '/ws/x.txt' }, fakeExec()), /only accepts PNG\/JPEG\/WebP\/GIF/)
  })

  // Regression guard for the post-0.1.1 dsh workspace gate: the fs service
  // returns undefined (not an error) for paths outside the session workspace,
  // which used to surface as a bare "reading 'size' of undefined" TypeError.
  it('reports a clear not-found error when the fs service cannot see the path', async () => {
    const fsImpl = {
      resolve: async (path) => ({ targetKey: path, displayPath: path }),
      stat: async () => undefined,
      readBytes: async () => { throw new Error('must not read') },
    }
    const tool = await mountTool({ fsImpl })
    await assert.rejects(() => tool.execute({ path: '/ws/x.png' }, fakeExec()), /cannot show "\/ws\/x\.png": not found/)
  })

  it('refuses oversized files before reading', async () => {
    const fsImpl = {
      resolve: async (path) => ({ path, displayPath: path }),
      stat: async () => ({ type: 'file', size: 10 * 1024 * 1024, version: 1 }),
      readBytes: async () => { throw new Error('must not read') },
    }
    const tool = await mountTool({ config: { maxImageBytes: 1024 }, fsImpl })
    await assert.rejects(() => tool.execute({ path: '/ws/big.png' }, fakeExec()), /larger than the configured 1024 byte limit/)
  })

  it('refuses pixel-over-limit images', async () => {
    const bigRef = { attachmentId: 'sha256:' + 'c'.repeat(64), mediaType: 'image/png', bytes: 4, width: 8000, height: 8000 }
    const tool = await mountTool({ config: { maxImagePixels: 1000 }, saveImageRef: bigRef })
    await assert.rejects(() => tool.execute({ path: '/ws/big.png' }, fakeExec()), /pixel limit/)
  })

  it('maps attachment service errors to clear messages', async () => {
    const mismatch = Object.assign(new Error('type mismatch'), { code: 'IMAGE_TYPE_MISMATCH' })
    const tool = await mountTool({ saveImageError: mismatch })
    await assert.rejects(() => tool.execute({ path: '/ws/x.png' }, fakeExec()), /bytes use a different image format/)
  })
})

describe('show_image HTTP route handler', () => {
  const ID = 'sha256:' + 'e'.repeat(64)
  const PNG_BYTES = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])

  // Mount apply() and capture the route handler from the webServer stub.
  async function mountRoute({ registryEntries = {}, readImageError } = {}) {
    const { apply } = await import('../dsh/index.js')
    const dir = mkdtempSync(join(tmpdir(), 'dsh-image-inline-route-'))
    process.env.DSH_HOME = dir
    // Seed the registry the handler reads.
    if (Object.keys(registryEntries).length > 0) {
      await internal.updateRegistry(join(dir, 'plugins', 'dsh-image-inline', 'registry.json'), () => registryEntries)
    }
    const injectCalls = []
    const ctx = {
      get: () => undefined,
      inject: (names, fn) => { injectCalls.push([names, fn]) },
    }
    apply(ctx, defaultConfig())
    let handler
    const webScope = {
      ...ctx,
      webServer: {
        register: (route) => { if (route.path === '/plugin/show-image') handler = route.handler; return () => {} },
      },
      effect: (fn) => fn(),
      get: (name) => name === 'attachments' ? {
        readImage: async (ref) => {
          if (readImageError) throw readImageError
          return { ref, data: PNG_BYTES }
        },
      } : undefined,
    }
    injectCalls[1][1](webScope)
    return { handler, dir }
  }

  /** Invoke the handler with a fake req/res; resolves {status, headers, body}. */
  function invoke(handler, { method = 'GET', url = `/plugin/show-image/${ID}` } = {}) {
    return new Promise((resolve) => {
      const chunks = []
      const res = {
        writeHead: (status, headers) => { res.status = status; res.headers = headers },
        end: (body) => { if (body) chunks.push(Buffer.from(body)); resolve({ status: res.status, headers: res.headers, body: Buffer.concat(chunks) }) },
      }
      handler({ method, url }, res)
    })
  }

  it('serves a registered image with content-type and immutable cache', async () => {
    const { handler, dir } = await mountRoute({
      registryEntries: { [ID]: { attachmentId: ID, mediaType: 'image/png', bytes: 8, width: 2, height: 2 } },
    })
    const result = await invoke(handler)
    assert.equal(result.status, 200)
    assert.equal(result.headers['content-type'], 'image/png')
    assert.equal(result.headers['cache-control'], 'public, max-age=31536000, immutable')
    assert.equal(result.body.length, PNG_BYTES.length)
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns 404 for unknown ids and malformed paths', async () => {
    const { handler, dir } = await mountRoute()
    assert.equal((await invoke(handler, { url: `/plugin/show-image/sha256:${'f'.repeat(64)}` })).status, 404)
    assert.equal((await invoke(handler, { url: '/plugin/show-image/not-an-id' })).status, 404)
    assert.equal((await invoke(handler, { url: '/plugin/show-image' })).status, 404)
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns 405 with allow header for non-GET methods', async () => {
    const { handler, dir } = await mountRoute()
    const result = await invoke(handler, { method: 'POST' })
    assert.equal(result.status, 405)
    assert.equal(result.headers.allow, 'GET, HEAD')
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns 503 when the attachment service is unavailable', async () => {
    const { apply } = await import('../dsh/index.js')
    const dir = mkdtempSync(join(tmpdir(), 'dsh-image-inline-route-'))
    process.env.DSH_HOME = dir
    await internal.updateRegistry(join(dir, 'plugins', 'dsh-image-inline', 'registry.json'), () => ({
      [ID]: { attachmentId: ID, mediaType: 'image/png', bytes: 8, width: 2, height: 2 },
    }))
    const injectCalls = []
    const ctx = { get: () => undefined, inject: (names, fn) => { injectCalls.push([names, fn]) } }
    apply(ctx, defaultConfig())
    let handler
    const webScope = {
      ...ctx,
      webServer: { register: (route) => { if (route.path === '/plugin/show-image') handler = route.handler; return () => {} } },
      effect: (fn) => fn(),
      get: () => undefined, // no attachments
    }
    injectCalls[1][1](webScope)
    const result = await invoke(handler)
    assert.equal(result.status, 503)
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns 404 when the stored image cannot be read', async () => {
    const { handler, dir } = await mountRoute({
      registryEntries: { [ID]: { attachmentId: ID, mediaType: 'image/png', bytes: 8, width: 2, height: 2 } },
      readImageError: new Error('ATTACHMENT_NOT_FOUND'),
    })
    const result = await invoke(handler)
    assert.equal(result.status, 404)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('show_image path route handler', () => {
  const PNG_BYTES = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])

  // Mount apply() and capture the PATH route handler (second registration).
  async function mountPathRoute({ fsImpl, config } = {}) {
    const { apply } = await import('../dsh/index.js')
    const injectCalls = []
    const ctx = { get: () => undefined, inject: (names, fn) => { injectCalls.push([names, fn]) } }
    apply(ctx, defaultConfig(config))
    const handlers = []
    const webScope = {
      ...ctx,
      webServer: {
        register: (route) => { handlers.push(route.handler); return () => {} },
      },
      effect: (fn) => fn(),
      get: (name) => name === 'fs' ? (fsImpl ?? {
        resolve: async (path) => ({ path, displayPath: path }),
        stat: async () => ({ type: 'file', size: PNG_BYTES.length, version: 1 }),
        readBytes: async () => PNG_BYTES,
      }) : undefined,
    }
    injectCalls[1][1](webScope)
    return handlers[1]
  }

  /** Invoke the handler with a fake req/res; resolves {status, headers, body}. */
  function invoke(handler, { method = 'GET', url = '/plugin/show-image-by-path?path=%2Fws%2Fa.png' } = {}) {
    return new Promise((resolve) => {
      const chunks = []
      const res = {
        writeHead: (status, headers) => { res.status = status; res.headers = headers },
        end: (body) => { if (body) chunks.push(Buffer.from(body)); resolve({ status: res.status, headers: res.headers, body: Buffer.concat(chunks) }) },
      }
      handler({ method, url }, res)
    })
  }

  it('serves an absolute path with content-type and a short private cache', async () => {
    const handler = await mountPathRoute()
    const result = await invoke(handler)
    assert.equal(result.status, 200)
    assert.equal(result.headers['content-type'], 'image/png')
    assert.equal(result.headers['cache-control'], 'private, max-age=60')
    assert.equal(result.body.length, PNG_BYTES.length)
  })

  it('rejects relative paths and missing query params', async () => {
    const handler = await mountPathRoute()
    assert.equal((await invoke(handler, { url: '/plugin/show-image-by-path?path=relative.png' })).status, 400)
    assert.equal((await invoke(handler, { url: '/plugin/show-image-by-path' })).status, 400)
  })

  it('returns 404 for unknown extensions, missing files, and non-GET methods', async () => {
    const handler = await mountPathRoute()
    assert.equal((await invoke(handler, { url: '/plugin/show-image-by-path?path=%2Fws%2Fa.txt' })).status, 404)
    const missing = await mountPathRoute({ fsImpl: {
      resolve: async (path) => ({ path, displayPath: path }),
      stat: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
      readBytes: async () => { throw new Error('must not read') },
    } })
    assert.equal((await invoke(missing)).status, 404)
    assert.equal((await invoke(handler, { method: 'POST' })).status, 405)
  })

  it('returns 413 for files over the configured byte cap', async () => {
    const handler = await mountPathRoute({ config: { maxImageBytes: 8 }, fsImpl: {
      resolve: async (path) => ({ path, displayPath: path }),
      stat: async () => ({ type: 'file', size: 9999, version: 1 }),
      readBytes: async () => { throw new Error('must not read') },
    } })
    const result = await invoke(handler)
    assert.equal(result.status, 413)
  })
})

describe('pathFromRouteQuery', () => {
  it('parses the path query parameter, decoded', () => {
    assert.equal(internal.pathFromRouteQuery('/plugin/show-image-by-path?path=%2Fws%2Fa.png'), '/ws/a.png')
  })
  it('returns null for absent or empty values and malformed URLs', () => {
    assert.equal(internal.pathFromRouteQuery('/plugin/show-image-by-path'), null)
    assert.equal(internal.pathFromRouteQuery('/plugin/show-image-by-path?path='), null)
    assert.equal(internal.pathFromRouteQuery('not a url'), null)
  })
})

describe('registry concurrency', () => {
  it('serializes concurrent updates without losing entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-image-inline-conc-'))
    const file = join(dir, 'registry.json')
    // Fire many updates in parallel; each adds a distinct key.
    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      internal.updateRegistry(file, (entries) => ({ ...entries, [`sha256:${String(i).padStart(64, '0')}`]: { attachmentId: `sha256:${String(i).padStart(64, '0')}`, mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }))
    ))
    const read = internal.readRegistry(file)
    assert.equal(Object.keys(read).length, 20, 'all 20 concurrent updates must survive')
    rmSync(dir, { recursive: true, force: true })
  })
})
