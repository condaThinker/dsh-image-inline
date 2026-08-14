// Client-half tests for dsh-image-inline (node --test).
//
// The browser half is a `window.__ModuleLoader__.load({id, factory})` script
// (zero-build lazy-CJS protocol). Two things are tested here:
//   1. The factory registers the cordis plugin exports and, when apply() is
//      run against a stub slots context, registers the show_image toolview.
//   2. The ShowImageCard component renders the three states (running,
//      settled-with-meta, error) to the expected DOM, using react-dom/server
//      static markup so no DOM container is needed.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'

// The rendering suite below needs react + react-dom. This repo is
// zero-install by design (no npm registry required for the host suite), so
// they are resolved from the environment instead of devDependencies:
//   - DSH_HARNESS_NODE_MODULES: any directory whose node_modules contains
//     react@18 + react-dom@18 (e.g. a DSH harness checkout), or
//   - this repo's own node_modules (after `npm install` of the
//     devDependencies).
// When no usable react is found the suite reports itself as skipped.
const HARNESS_NODE_MODULES =
  process.env.DSH_HARNESS_NODE_MODULES ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules')
const require = createRequire(import.meta.url)

/** Locate react-dom/server.node.js, tolerating different pnpm store layouts. */
function resolveReactDomServer() {
  const candidates = []
  const direct = join(HARNESS_NODE_MODULES, 'react-dom', 'server.node.js')
  const pnpmDir = join(HARNESS_NODE_MODULES, '.pnpm')
  if (existsSync(direct)) candidates.push(direct)
  if (existsSync(pnpmDir)) {
    for (const entry of readdirSync(pnpmDir)) {
      if (entry.startsWith('react-dom@')) {
        candidates.push(join(pnpmDir, entry, 'node_modules', 'react-dom', 'server.node.js'))
      }
    }
  }
  return candidates.find((p) => existsSync(p)) ?? null
}

/** React kit for the rendering suite, or { error } when unavailable. */
const renderKit = (() => {
  try {
    const React = require(join(HARNESS_NODE_MODULES, 'react'))
    const serverPath = resolveReactDomServer()
    if (!serverPath) throw new Error(`react-dom/server not found under ${HARNESS_NODE_MODULES}`)
    const reactDom = require(serverPath)
    return { React, renderToStaticMarkup: reactDom.renderToStaticMarkup }
  } catch (err) {
    return { error: err }
  }
})()

/** Minimal fake require serving the platform modules the bundle requests. */
function makeRequire({ react, attachment }) {
  const table = {
    react,
    '@deepseek-ai/dsh-client-ui-attachment': attachment,
  }
  return (name) => {
    if (!(name in table)) throw new Error(`client test: unexpected require("${name}")`)
    return table[name]
  }
}

/** Load dsh/client.js through the __ModuleLoader__ protocol and capture the exports. */
function loadClientBundle({ react, attachment }) {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'dsh', 'client.js'), 'utf8')
  let captured
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => { captured = { id, factory } },
    },
  }
  // The bundle references `window` at load time; run it in a sandboxed fn
  // whose ONLY scope is window — deliberately NO require parameter here, so
  // a factory that captures `require` as a free variable fails exactly like
  // it does in the browser (ReferenceError: require is not defined). The
  // loader protocol requires `factory: (require) => ...`.
  const run = new Function('window', `${source}\n//# sourceURL=dsh-image-inline-client.js`)
  run(globalThis.window)
  // Mirror the real loader contract: factory(require) → module exports.
  const exports = captured.factory(makeRequire({ react, attachment }))
  return { id: captured.id, exports }
}

describe('dsh/client.js bundle', () => {
  it('loads through the __ModuleLoader__ protocol with the plugin id', () => {
    const { id } = loadClientBundle({ react: {}, attachment: {} })
    assert.equal(id, 'dsh-image-inline')
  })

  // Regression guard for the loader-entry incident: the lazy-CJS protocol
  // requires `factory: (require) => ...`. A factory that captures `require`
  // as a free variable passes this suite's older harness (which scoped
  // require at evaluation) but throws `require is not defined` in the
  // browser. The harness now evaluates the bundle with ONLY `window` in
  // scope, so this test fails loudly if the signature regresses.
  it('materializes with the loader-injected require (factory(require) contract)', () => {
    const { exports } = loadClientBundle({ react: {}, attachment: {} })
    assert.equal(typeof exports.apply, 'function')
  })

  it('exports the cordis plugin shape', () => {
    const { exports } = loadClientBundle({ react: {}, attachment: {} })
    assert.equal(exports.name, 'image-inline')
    assert.deepEqual(exports.inject, ['slots'])
    assert.equal(typeof exports.apply, 'function')
  })

  it('registers the show_image toolview when slots mount', () => {
    const registrations = []
    const ctx = {
      get: () => undefined,
      slots: {
        inject: (name, fn) => {
          assert.equal(name, 'tool.call.toolview')
          fn()
        },
        register: (def, Component) => {
          registrations.push({ def, Component })
          return () => {}
        },
      },
      effect: (fn, label) => { /* locale registration is optional; disposer unused */ },
    }
    const { exports } = loadClientBundle({ react: {}, attachment: {} })
    exports.apply(ctx)
    assert.equal(registrations.length, 1)
    assert.equal(registrations[0].def.name, 'tool.call.toolview')
    assert.equal(registrations[0].def.key, 'show_image')
    assert.equal(registrations[0].def.locale, 'image-inline')
    assert.equal(typeof registrations[0].Component, 'function')
  })
})

describe('ShowImageCard rendering', () => {
  if (renderKit.error) {
    it('skips the rendering suite (react/react-dom not resolvable)', (t) => {
      t.skip(renderKit.error.message)
    })
    return
  }
  const { React, renderToStaticMarkup } = renderKit
  let ShowImageCard

  before(() => {
    // The real ui-attachment cannot be imported in node; stub MessageImage as
    // a component that renders its attachment + load result.
    const attachment = {
      MessageImage: (props) =>
        React.createElement('img', {
          'data-testid': 'message-image',
          alt: props.attachment.attachmentId,
        }),
    }
    const { exports } = loadClientBundle({ react: React, attachment })
    // Capture the component registered by apply() through the slots contract:
    // inject defers to register, which records the (definition, Component).
    let capturedComponent
    const ctx = {
      get: () => undefined,
      slots: {
        inject: (name, fn) => { fn() },
        register: (def, Component) => {
          if (def.name === 'tool.call.toolview') capturedComponent = Component
          return () => {}
        },
      },
      effect: () => {},
    }
    exports.apply(ctx)
    assert.ok(capturedComponent, 'apply must register the toolview component')
    ShowImageCard = capturedComponent
  })

  it('renders a running call as a compact summary row', () => {
    const block = { callId: 'c1', name: 'show_image', argsRaw: '{"path":"/ws/a.png"}', turn: 1, step: 2, time: 1, callView: null, subCalls: [] }
    const html = renderToStaticMarkup(React.createElement(ShowImageCard, {
      callId: 'c1', toolName: 'show_image', block,
      t: (key) => key,
    }))
    assert.match(html, /data-image-inline-card="running"/)
    assert.match(html, /title\.running/)
  })

  it('renders a settled result with meta as an inline image card', () => {
    const block = {
      kind: 'tool-result',
      seq: 10, time: 2, callId: 'c1',
      call: { name: 'show_image', argsRaw: '{"path":"/ws/a.png"}' },
      callTime: 1,
      content: [{ type: 'text', text: '<path>/ws/a.png</path>' }],
      isError: false,
      meta: {
        path: '/ws/a.png',
        attachmentId: 'sha256:' + 'd'.repeat(64),
        mediaType: 'image/png', bytes: 123, width: 800, height: 600,
      },
      callView: null, resultView: null, subCalls: [],
    }
    const html = renderToStaticMarkup(React.createElement(ShowImageCard, {
      callId: 'c1', toolName: 'show_image', block,
      t: (key, params) => key + (params ? JSON.stringify(params) : ''),
    }))
    assert.match(html, /data-image-inline-card="done"/)
    assert.match(html, /data-testid="message-image"/)
    assert.match(html, /sha256:dddd/)
  })

  it('renders an error result without crashing', () => {
    const block = {
      kind: 'tool-result',
      seq: 10, time: 2, callId: 'c1',
      call: { name: 'show_image', argsRaw: '{"path":"/ws/missing.png"}' },
      callTime: 1,
      content: [{ type: 'text', text: 'cannot show "/ws/missing.png": not found' }],
      isError: true,
      callView: null, resultView: null, subCalls: [],
    }
    const html = renderToStaticMarkup(React.createElement(ShowImageCard, {
      callId: 'c1', toolName: 'show_image', block,
      t: (key, params) => key,
    }))
    assert.match(html, /data-image-inline-card="error"/)
    assert.match(html, /summary\.error/)
  })

  it('renders a settled result without meta as a text fallback', () => {
    const block = {
      kind: 'tool-result',
      seq: 10, time: 2, callId: 'c1',
      call: { name: 'show_image', argsRaw: '{"path":"/ws/a.png"}' },
      callTime: 1,
      content: [{ type: 'text', text: '<path>/ws/a.png</path>' }],
      isError: false,
      callView: null, resultView: null, subCalls: [],
    }
    const html = renderToStaticMarkup(React.createElement(ShowImageCard, {
      callId: 'c1', toolName: 'show_image', block,
      t: (key) => key,
    }))
    assert.match(html, /data-image-inline-card="meta-missing"/)
    assert.match(html, /meta\.missing/)
  })
})
