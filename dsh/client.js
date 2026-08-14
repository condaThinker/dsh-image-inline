// dsh-image-inline, browser half.
//
// Renders the `show_image` tool call inside the chat flow as an inline image
// card (QQ/WeChat style: the picture sits in the conversation, scrolls with
// history, and survives replays). The card is registered as an atomic Tool
// view — the `tool.call.toolview` keyed slot, dispatched by the wire tool
// name — so the generic Tool call tree renders OUR row for every show_image
// call, at the call's own position in the turn.
//
// The card is a pure function of the call node: while running it shows a
// compact summary row; once settled it reads the tool's private `meta`
// payload (attachmentId/mediaType/bytes/width/height — threaded from the
// host's `output.presentationMeta` through the tool/result event, never part
// of model context) and renders the image through the official MessageImage
// atom. Loading uses the plugin's own content-addressed HTTP route, so no
// session-log attachment reference is required (the built-in resolveImage
// path cannot serve tool-produced attachments whose result is text-only).
//
// Hand-written in the lazy-CJS bundle protocol (window.__ModuleLoader__.load
// with a factory returning cordis-plugin exports), modlens-style: no build
// step, no imports from dsh client packages beyond the platform modules the
// loader seeds (react, ui-attachment, ui-primitives).

window.__ModuleLoader__.load({
  id: 'dsh-image-inline',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var attachment = require('@deepseek-ai/dsh-client-ui-attachment')

    var MessageImage = attachment.MessageImage

    /** Namespace this plugin owns in the DSH locale registry. */
    var NS = 'image-inline'

    /** Simplified Chinese dictionary (the key-set source of truth). */
    var zh = {
      'title.running': '显示图片 {path}',
      'title.done': '图片已显示',
      'summary.done': '{path} · {width}x{height}px · {bytes} bytes',
      'summary.error': '图片显示失败：{error}',
      'meta.missing': '缺少图片信息（attachmentId 不可用）',
      'label.image': '图片',
      'label.open': '查看原图',
      'label.openNamed': '查看原图 {name}',
      'label.loading': '加载中…',
      'label.loadFailed': '加载失败，点击重试',
      'lightbox.dialog': '原图预览',
      'lightbox.close': '关闭预览',
      'aria.card': '显示图片：{path}',
    }

    /** The image-inline namespace key union. */
    var zhKeys = Object.keys(zh)

    /** English dictionary, checked complete against the zh key set. */
    var en = {
      'title.running': 'Show image {path}',
      'title.done': 'Image shown',
      'summary.done': '{path} · {width}x{height}px · {bytes} bytes',
      'summary.error': 'Failed to show image: {error}',
      'meta.missing': 'Image metadata missing (attachmentId unavailable)',
      'label.image': 'Image',
      'label.open': 'View original',
      'label.openNamed': 'View original {name}',
      'label.loading': 'Loading…',
      'label.loadFailed': 'Load failed, click to retry',
      'lightbox.dialog': 'Original preview',
      'lightbox.close': 'Close preview',
      'aria.card': 'Show image: {path}',
    }

    /** Parse the raw JSON arguments of a running call; best-effort, never throws. */
    function parseArgs(argsRaw) {
      if (typeof argsRaw !== 'string') return {}
      try {
        var parsed = JSON.parse(argsRaw)
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch (error) {
        return {}
      }
    }

    /** The plugin's content-addressed image URL for one attachment id. */
    function imageUrl(attachmentId) {
      return '/plugin/show-image/' + encodeURIComponent(String(attachmentId))
    }

    /** Build the MessageImage labels from the locale seat. */
    function imageLabels(t) {
      return {
        image: t('label.image'),
        open: t('label.open'),
        openNamed: function (name) { return t('label.openNamed', { name: name }) },
        loading: t('label.loading'),
        loadFailed: t('label.loadFailed'),
        lightbox: {
          dialog: t('lightbox.dialog'),
          close: t('lightbox.close'),
        },
      }
    }

    /** The inline image card for one show_image call. */
    function ShowImageCard(props) {
      if (!props || typeof props !== 'object') return null
      var block = props.block
      // The locale seat is normally injected; fall back to an identity
      // translator so a missing seat degrades to raw keys instead of a crash.
      var t = typeof props.t === 'function' ? props.t : function (key) { return key }
      if (!block || typeof block !== 'object') return null
      if ('kind' in block) {
        // Settled result.
        if (block.isError === true) {
          var errorText = ''
          var content = block.content || []
          for (var i = 0; i < content.length; i++) {
            if (content[i] && content[i].type === 'text') errorText += content[i].text
          }
          return React.createElement(
            'div',
            { 'data-image-inline-card': 'error', role: 'status' },
            React.createElement(
              'span',
              { className: 'dsh-image-inline-error' },
              t('summary.error', { error: errorText || 'unknown' }),
            ),
          )
        }
        var meta = block.meta
        if (
          meta && typeof meta === 'object'
          && typeof meta.attachmentId === 'string'
          && typeof meta.mediaType === 'string'
          && typeof meta.width === 'number'
          && typeof meta.height === 'number'
          && typeof meta.bytes === 'number'
        ) {
          var ref = {
            attachmentId: meta.attachmentId,
            mediaType: meta.mediaType,
            bytes: meta.bytes,
            width: meta.width,
            height: meta.height,
          }
          var path = typeof meta.path === 'string' ? meta.path : ''
          var row = React.createElement(
            'span',
            { 'data-image-inline-summary': true, title: path },
            t('summary.done', {
              path: path,
              width: meta.width,
              height: meta.height,
              bytes: meta.bytes,
            }),
          )
          var img = React.createElement(MessageImage, {
            attachment: ref,
            variant: 'single',
            labels: imageLabels(t),
            load: function () {
              return Promise.resolve(imageUrl(ref.attachmentId))
            },
          })
          return React.createElement(
            'div',
            { 'data-image-inline-card': 'done' },
            row,
            img,
          )
        }
        // Settled but no usable meta (e.g. a replay written by an older
        // schema): show the plain text result.
        var fallback = ''
        var blocks = block.content || []
        for (var j = 0; j < blocks.length; j++) {
          if (blocks[j] && blocks[j].type === 'text') fallback += blocks[j].text
        }
        return React.createElement(
          'div',
          { 'data-image-inline-card': 'meta-missing' },
          React.createElement('span', null, t('meta.missing')),
          fallback ? React.createElement('pre', null, fallback) : null,
        )
      }
      // Running call.
      var args = parseArgs(block.argsRaw)
      var runningPath = typeof args.path === 'string' ? args.path : ''
      return React.createElement(
        'div',
        { 'data-image-inline-card': 'running' },
        React.createElement('span', null, t('title.running', { path: runningPath || '…' })),
      )
    }

    /**
     * Cordis client plugin body.
     * @param ctx - client root context (slots service injected).
     */
    function apply(ctx) {
      var locale = ctx.get ? ctx.get('locale') : undefined
      if (locale && typeof locale.register === 'function') {
        ctx.effect(function () { return locale.register(NS, { zh: zh, en: en }) }, 'dsh-image-inline: dictionaries')
      }

      ctx.slots.inject('tool.call.toolview', function () {
        return ctx.slots.register({
          name: 'tool.call.toolview',
          key: 'show_image',
          locale: NS,
        }, ShowImageCard)
      })
    }

    exports.name = 'image-inline'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
