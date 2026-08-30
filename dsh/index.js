// dsh-image-inline, host half.
//
// Registers a `show_image` tool: the model hands it a disk image path, the
// bytes are durably committed through the DSH attachment service, and the
// tool result is TEXT ONLY — the message content (and therefore the model
// context) carries the path and a metadata summary, never an image block.
// The browser half renders the picture inline in the chat flow by loading
// the plugin's own content-addressed HTTP route.
//
// Why a plugin-owned HTTP route instead of the built-in
// conversation.resolveImage? The built-in `session.attachment` RPC only
// serves attachments whose id appears in an image block inside the session
// log (api-proxy `referencedImage`). A text-only result deliberately never
// references the attachment, so the plugin must serve the bytes itself. The
// attachment id is `sha256:<hex>` — a content-addressed capability: knowing
// it means knowing the image, and it only appears in the session log the
// user can already read. The server binds loopback by default, the same
// trust model as the rest of the web UI.
//
// Zero-dependency by design (modlens pattern): raw JSON-Schema tool
// definition, no imports from @deepseek-ai/* packages (out-of-tree
// resolution of those is not reliable for standalone plugins). Node
// builtins only.
//
// The attachment ref (mediaType/bytes/width/height) cannot be reconstructed
// from the id alone — `attachments.readImage` verifies the ref against the
// stored bytes and rejects a mismatched one. So the ref metadata is
// persisted to a durable registry under $DSH_HOME at tool-execution time;
// the HTTP route looks it up there. This keeps history renderable across
// host restarts (the `meta` on tool/result events is in the session log,
// and the registry survives on disk).

import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, join } from 'node:path'

export const name = 'image-inline'

/** Services required before the plugin activates. */
export const inject = ['tools']

/** Media types accepted, keyed by the file extension that declares them. */
const MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** Plugin config defaults (the cordis.patch.yml layer can override these). */
const DEFAULTS = {
  maxImageBytes: 25 * 1024 * 1024,
  maxImagePixels: 40_000_000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

/** HTTP route prefix serving one image by its content-addressed attachment id. */
const ROUTE_PREFIX = '/plugin/show-image'

/**
 * HTTP route prefix serving one image by its display path (query `?path=`).
 * Fallback for results whose `tool/result`/`tool/code-dispatch` event carries
 * no attachment meta — nested `show_image` calls dispatched from inside
 * `run_code` (the host tool registry only projects `presentationMeta` for
 * top-level executions) and replays written before the meta schema. The model
 * already committed the path to the session text, so the client can ask this
 * route for the bytes and still render the picture.
 */
const PATH_ROUTE_PREFIX = '/plugin/show-image-by-path'

/** The `sha256:<64-hex>` attachment id shape, anchored for route extraction. */
const ATTACHMENT_ID_PATTERN = /^sha256:[0-9a-f]{64}$/

/** Resolve the plugin's durable registry path ($DSH_HOME/plugins/dsh-image-inline/registry.json). */
function registryPath(override) {
  if (typeof override === 'string' && override.length > 0) return override
  const home = process.env.DSH_HOME || join(process.env.HOME || process.env.USERPROFILE || '', '.dsh')
  return join(home, 'plugins', 'dsh-image-inline', 'registry.json')
}

/** Atomic JSON write: same-directory temp file + fsync + rename (no-clobber via rename semantics). */
function writeRegistryAtomically(file, entries) {
  const dir = file.slice(0, file.lastIndexOf('/'))
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.registry-${process.pid}-${Date.now()}.tmp`)
  const body = JSON.stringify(entries, null, 2)
  const fd = createWriteStream(tmp, { flags: 'wx', mode: 0o600 })
  return new Promise((resolve, reject) => {
    fd.on('error', reject)
    fd.on('open', () => {
      fd.write(body, (writeError) => {
        if (writeError) { fd.destroy(); reject(writeError); return }
        fd.end(() => {
          try {
            renameSync(tmp, file)
            resolve()
          } catch (renameError) {
            try { rmSync(tmp, { force: true }) } catch { /* best effort */ }
            reject(renameError)
          }
        })
      })
    })
  })
}

/** Read the registry, tolerating absence and torn tails (rewrite on parse failure). */
function readRegistry(file) {
  if (!existsSync(file)) return {}
  let raw
  try {
    raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed
  } catch {
    // Torn tail or foreign content: rebuild from an empty registry.
  }
  return {}
}

// The registry is a plain JSON file with read-modify-write updates. Calls can
// arrive concurrently (parallel tool calls, multiple sessions), so every
// update runs on one in-process promise chain: a later update reads the file
// only after the previous write settled, which prevents lost entries. The
// chain survives failures (a failed write does not wedge later updates).
let registryWriteChain = Promise.resolve()

/** Serialize one registry update behind the in-process write queue. */
function updateRegistry(file, mutator) {
  const run = registryWriteChain.then(() => {
    const entries = readRegistry(file)
    const next = mutator(entries)
    return writeRegistryAtomically(file, next)
  })
  registryWriteChain = run.catch(() => {})
  return run
}

/** Whether the file extension declares one of the configured media types. */
function mediaTypeForPath(filePath, config) {
  const declared = MEDIA_TYPES[extname(filePath).toLowerCase()]
  if (declared === undefined) return undefined
  return config.mediaTypes.includes(declared) ? declared : undefined
}

/** Resolve a model-supplied path against the session workspace, DSH-style. */
async function resolveDisplayPath(ctx, exec, requestedPath) {
  const fs = ctx.get?.('fs')
  if (fs && typeof fs.resolve === 'function' && typeof fs.stat === 'function') {
    const cwd = exec.agent?.session?.header?.cwd
    const target = await fs.resolve(requestedPath, {
      ...typeof cwd === 'string' ? { cwd } : {},
      signal: exec.signal,
    })
    // The fs service stat()s the resolved target. Current DSH fs services
    // gate access to the session workspace: a path outside it (or otherwise
    // not visible through the policy) makes stat() return undefined instead
    // of throwing — so surface a clear error rather than a bare TypeError
    // downstream ("reading 'size' of undefined").
    const info = await fs.stat(target, exec.signal)
    if (info === undefined) {
      const error = new Error(
        `cannot show "${target.displayPath}": not found${isAbsolute(requestedPath) && !requestedPath.startsWith(cwd ?? '/nonexistent') ? ' (path is outside the current session workspace)' : ''}`,
      )
      error.code = 'FS_NOT_FOUND'
      throw error
    }
    if (typeof info.size !== 'number') {
      const error = new Error(`cannot show "${target.displayPath}": not a regular file`)
      error.code = 'FS_NOT_REGULAR_FILE'
      throw error
    }
    return { target, info }
  }
  // No fs service (unlikely): accept only absolute paths, resolve plainly.
  if (!isAbsolute(requestedPath)) {
    const error = new Error(`cannot show "${requestedPath}": only absolute image paths are accepted`)
    error.code = 'NOT_ABSOLUTE'
    throw error
  }
  const target = { path: requestedPath, displayPath: requestedPath }
  let info
  try {
    info = statSync(requestedPath)
  } catch (statError) {
    const error = new Error(`cannot show "${requestedPath}": not found`)
    error.code = 'FS_NOT_FOUND'
    throw error
  }
  if (!info.isFile()) {
    const error = new Error(`cannot show "${requestedPath}": not a regular file`)
    error.code = 'FS_NOT_REGULAR_FILE'
    throw error
  }
  return { target, info }
}

/** Read the file bytes, honoring the configured byte cap. */
async function readBytes(ctx, target, signal, byteCap) {
  const fs = ctx.get?.('fs')
  if (fs && typeof fs.readBytes === 'function') {
    return fs.readBytes(target, signal, byteCap)
  }
  const { readFile } = await import('node:fs/promises')
  const data = await readFile(target.targetKey ?? target.path)
  if (data.byteLength > byteCap) {
    const error = new Error(`cannot show "${target.displayPath}": file is larger than the configured ${byteCap} byte limit`)
    error.code = 'TOO_LARGE'
    throw error
  }
  return data
}

/** The text-only model-facing render: path + metadata summary. */
function formatShowImageOutput(displayPath, image) {
  return `<path>${displayPath}</path>
<type>image</type>
<content>
${image.mediaType} image, ${image.width}x${image.height} px, ${image.bytes} bytes
</content>`
}

/**
 * Build the `show_image` tool definition.
 * @param ctx - plugin context (tools service required).
 * @param config - resolved plugin config.
 * @param registryFile - durable ref-registry path.
 */
function showImageTool(ctx, config, registryFile) {
  return {
    name: 'show_image',
    description:
      'Render an image file into the user-visible chat flow (QQ/WeChat style: the picture appears inline in the conversation, scrollable with history). The image bytes are durably stored as an attachment; the message content keeps only the path and a metadata summary, and the image itself NEVER enters model context. Use this whenever the user should SEE an image the assistant has produced or found on disk (screenshots, charts, generated images, downloaded files). The image must be a PNG/JPEG/WebP/GIF file on disk. Errors are reported in the result text.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Absolute path of the image file to show in the chat (PNG/JPEG/WebP/GIF). Resolved against the session workspace when relative.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          attachmentId: { type: 'string' },
          mediaType: { type: 'string' },
          bytes: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
        },
        required: ['path', 'attachmentId', 'mediaType', 'bytes', 'width', 'height'],
        additionalProperties: false,
      },
      // Text only: this is the entire model-visible result.
      render: (_args, value) => [{ type: 'text', text: formatShowImageOutput(value.path, value) }],
      // Threaded verbatim into the tool/result event `meta`, read by the
      // browser half to build the image URL and card. Never model-visible.
      presentationMeta: (_args, value) => ({
        path: value.path,
        attachmentId: value.attachmentId,
        mediaType: value.mediaType,
        bytes: value.bytes,
        width: value.width,
        height: value.height,
      }),
    },
    // Content-addressed writes are idempotent; concurrent calls cannot conflict.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const pathArg = args.path
      if (typeof pathArg !== 'string' || pathArg.trim().length === 0) {
        throw new Error('show_image: path must be a non-empty string')
      }

      const mediaType = mediaTypeForPath(pathArg, config)
      if (mediaType === undefined) {
        const allowed = config.mediaTypes.join(', ')
        throw new Error(`cannot show "${pathArg}": show_image only accepts PNG/JPEG/WebP/GIF paths (configured: ${allowed})`)
      }

      const attachments = ctx.get?.('attachments')
      if (attachments === undefined) {
        throw new Error(`cannot show "${pathArg}" as an image: no attachment service is mounted`)
      }

      const { target, info } = await resolveDisplayPath(ctx, exec, pathArg)

      const byteCap = config.maxImageBytes
      if (typeof info.size === 'number' && info.size > byteCap) {
        throw new Error(`cannot show "${target.displayPath}": file is ${info.size} bytes, larger than the configured ${byteCap} byte limit`)
      }

      const data = await readBytes(ctx, target, exec.signal, byteCap)

      let ref
      try {
        ref = await attachments.saveImage({
          data,
          mediaType,
          name: basename(target.displayPath),
        })
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
        if (code === 'IMAGE_TYPE_MISMATCH') {
          throw new Error(
            `cannot show "${target.displayPath}": the ${extname(target.displayPath).toLowerCase()} extension declares ${mediaType}, but the bytes use a different image format; rename the file to match its actual format if it is PNG/JPEG/WebP/GIF, or convert it to one of those formats`,
            { cause: error },
          )
        }
        if (code === 'INVALID_IMAGE' || code === 'IMAGE_TOO_LARGE' || code === 'IMAGE_PIXELS_EXCEEDED') {
          throw new Error(`cannot show "${target.displayPath}": ${error.message}`, { cause: error })
        }
        throw error
      }

      const pixels = ref.width * ref.height
      if (config.maxImagePixels > 0 && pixels > config.maxImagePixels) {
        throw new Error(
          `cannot show "${target.displayPath}": image is ${ref.width}x${ref.height} (${pixels} pixels), larger than the configured ${config.maxImagePixels} pixel limit`,
        )
      }

      // Persist the ref so the HTTP route can serve the bytes after restarts.
      try {
        await updateRegistry(registryFile, (entries) => {
          const next = { ...entries }
          next[String(ref.attachmentId)] = {
            attachmentId: String(ref.attachmentId),
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
          }
          return next
        })
      } catch (error) {
        // The image is committed; a failed registry write must not fail the
        // call, but the browser cannot load it — surface the limitation.
        console.error(`[dsh-image-inline] registry write failed: ${error}`)
      }

      ctx.emit?.('fs/observed', target, { kind: 'present', version: info.version }, exec)

      return {
        path: target.displayPath,
        attachmentId: String(ref.attachmentId),
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
      }
    },
  }
}

/** Parse an attachment id from the route pathname, or null when malformed. */
function attachmentIdFromPath(pathname) {
  if (!pathname.startsWith(ROUTE_PREFIX + '/')) return null
  const raw = pathname.slice(ROUTE_PREFIX.length + 1)
  let id
  try {
    id = decodeURIComponent(raw)
  } catch {
    return null
  }
  return ATTACHMENT_ID_PATTERN.test(id) ? id : null
}

/** Parse the `path` query parameter from a request URL, or null when absent. */
function pathFromRouteQuery(url) {
  let parsed
  try {
    parsed = new URL(url, 'http://localhost')
  } catch {
    return null
  }
  const value = parsed.searchParams.get('path')
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** Content-type header for one media type. */
function contentTypeFor(mediaType) {
  const table = {
    'image/png': 'image/png',
    'image/jpeg': 'image/jpeg',
    'image/webp': 'image/webp',
    'image/gif': 'image/gif',
  }
  return table[mediaType] ?? 'application/octet-stream'
}

/**
 * Register the image-serving HTTP route (web profile only). The attachment id
 * is a content-addressed capability: it appears only in session logs the
 * user can read, so possession of the id authorizes the fetch under the
 * same loopback trust model as the rest of the web UI.
 *
 * @param scope - the injected scope that carries `webServer` (Cordis
 *   forbids reading an injected service as a property of an uninjected
 *   context); `get` on the scope also reaches the attachments service.
 * @param registryFile - durable ref-registry path.
 */
function registerImageRoute(scope, registryFile) {
  const disposer = scope.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      let pathname
      try {
        pathname = new URL(req.url, 'http://localhost').pathname
      } catch {
        res.writeHead(400)
        res.end('bad request')
        return
      }
      const id = attachmentIdFromPath(pathname)
      if (id === null) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const entry = readRegistry(registryFile)[id]
      if (entry === undefined) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const attachments = scope.get?.('attachments')
      if (attachments === undefined) {
        res.writeHead(503)
        res.end('attachment service unavailable')
        return
      }
      let stored
      try {
        stored = await attachments.readImage(entry)
      } catch {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const body = stored.data
      const headers = {
        'content-type': contentTypeFor(entry.mediaType),
        // Content-addressed and immutable: safe to cache long.
        'cache-control': 'public, max-age=31536000, immutable',
        'content-length': String(body.byteLength),
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, headers)
        res.end()
        return
      }
      res.writeHead(200, headers)
      res.end(Buffer.from(body))
    },
  })
  return disposer
}

/**
 * Serve one image by its display path (query `?path=`), validating exactly
 * like `execute` does: media type by file extension, regular file, configured
 * byte cap. This is the rendering fallback for results without attachment
 * meta — nested `show_image` calls dispatched from `run_code` and replays of
 * sessions written before the meta schema. The path is taken from the
 * session text the model produced, under the same loopback trust model as
 * the content-addressed route.
 *
 * @param scope - the injected scope that carries `webServer`; `get` on it
 *   reaches the fs service (and attachments, though unused here).
 * @param config - resolved plugin config (mediaTypes / maxImageBytes).
 */
function registerPathImageRoute(scope, config) {
  const disposer = scope.webServer.register({
    kind: 'prefix',
    path: PATH_ROUTE_PREFIX,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      const requestedPath = pathFromRouteQuery(req.url ?? '')
      if (requestedPath === null || !isAbsolute(requestedPath)) {
        res.writeHead(400)
        res.end('bad request')
        return
      }
      const mediaType = mediaTypeForPath(requestedPath, config)
      if (mediaType === undefined) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const fs = scope.get?.('fs')
      let target
      try {
        if (fs && typeof fs.resolve === 'function' && typeof fs.stat === 'function') {
          target = await fs.resolve(requestedPath, {})
          const info = await fs.stat(target)
          if (typeof info.size === 'number' && info.size > config.maxImageBytes) {
            res.writeHead(413)
            res.end('image too large')
            return
          }
        } else {
          const info = statSync(requestedPath)
          if (!info.isFile()) {
            res.writeHead(404)
            res.end('not found')
            return
          }
          if (info.size > config.maxImageBytes) {
            res.writeHead(413)
            res.end('image too large')
            return
          }
          target = { path: requestedPath, displayPath: requestedPath }
        }
      } catch {
        res.writeHead(404)
        res.end('not found')
        return
      }
      let data
      try {
        data = await readBytes(scope, target, undefined, config.maxImageBytes)
      } catch {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const headers = {
        'content-type': contentTypeFor(mediaType),
        // Path-addressed, not content-addressed: the file may change, so no
        // immutable long cache. A modest private cache keeps repeated history
        // scrolls cheap without pinning stale bytes for long.
        'cache-control': 'private, max-age=60',
        'content-length': String(data.byteLength),
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, headers)
        res.end()
        return
      }
      res.writeHead(200, headers)
      res.end(Buffer.from(data))
    },
  })
  return disposer
}

/** Validate resolved config values; throws on invalid input. */
function assertConfig(config) {
  if (!Number.isInteger(config.maxImageBytes) || config.maxImageBytes < 1) {
    throw new Error('dsh-image-inline: maxImageBytes must be a positive integer')
  }
  if (!Number.isInteger(config.maxImagePixels) || config.maxImagePixels < 0) {
    throw new Error('dsh-image-inline: maxImagePixels must be a non-negative integer (0 disables the cap)')
  }
  if (!Array.isArray(config.mediaTypes) || config.mediaTypes.length === 0) {
    throw new Error('dsh-image-inline: mediaTypes must be a non-empty array')
  }
  for (const mediaType of config.mediaTypes) {
    if (typeof mediaType !== 'string' || !Object.values(MEDIA_TYPES).includes(mediaType)) {
      throw new Error(`dsh-image-inline: unsupported mediaType "${mediaType}"`)
    }
  }
}

/**
 * Cordis plugin body.
 * @param ctx - plugin context (tools service injected).
 * @param config - resolved config from the bundle layer (defaults applied by the Loader).
 */
export function apply(ctx, config = {}) {
  const resolved = { ...DEFAULTS, ...config }
  assertConfig(resolved)
  const registryFile = registryPath(resolved.registryPath)

  // The tool needs the attachment service; register conditionally so a
  // composition without one stays inert (mirrors read_image's stance).
  // A duplicate `show_image` registration throws in the registry and would
  // otherwise fail the whole plugin fiber (modlens issue #21), so it is
  // caught here and reported loudly instead.
  ctx.inject(['attachments'], (attachmentsCtx) => {
    try {
      attachmentsCtx.tools.register(showImageTool(ctx, resolved, registryFile))
    } catch (error) {
      console.error(`[dsh-image-inline] show_image tool registration failed: ${error}`)
    }
  })

  // The HTTP routes are web-only; register when the web server appears. The
  // routes must be registered on the injected scope (its `webServer` property
  // is only readable there), not on the outer ctx.
  ctx.inject(['webServer'], (webCtx) => {
    try {
      webCtx.effect(() => registerImageRoute(webCtx, registryFile), 'dsh-image-inline: image route')
      webCtx.effect(() => registerPathImageRoute(webCtx, resolved), 'dsh-image-inline: path image route')
    } catch (error) {
      console.error(`[dsh-image-inline] image route skipped: ${error}`)
    }
  })
}

/** Test-only escape hatch: keep the pure helpers reachable from node --test. */
export const _internal = {
  MEDIA_TYPES,
  DEFAULTS,
  ROUTE_PREFIX,
  PATH_ROUTE_PREFIX,
  ATTACHMENT_ID_PATTERN,
  registryPath,
  readRegistry,
  writeRegistryAtomically,
  updateRegistry,
  mediaTypeForPath,
  formatShowImageOutput,
  attachmentIdFromPath,
  pathFromRouteQuery,
  contentTypeFor,
  assertConfig,
}
