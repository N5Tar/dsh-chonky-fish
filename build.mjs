/**
 * Build `client.js` from the chat-UI sources.
 *
 * The bundle ships one self-contained Client module: the design's CSS and
 * markup are extracted from `src/original.html`, adapted for a Shadow DOM page
 * (so its generic class names never leak into the Harness UI), and combined
 * with `src/runtime.js` — the page's own controller — plus the React shell that
 * registers the sidebar entry and the main panel. `src/assets.json` carries the
 * optimised illustration poses as data URIs; they are injected into the module
 * so the client bundle needs no extra network fetches.
 *
 *   node build.mjs            # writes ./client.js
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sourcePath = process.env.DFY_SOURCE || join(here, 'src/original.html')

const raw = readFileSync(sourcePath, 'utf8')
const assets = JSON.parse(readFileSync(join(here, 'src/assets.json'), 'utf8'))
const styleMatch = raw.match(/<style>([\s\S]*?)<\/style>/)
const bodyMatch = raw.match(/<body>([\s\S]*)<\/body>/)
if (!styleMatch || !bodyMatch) throw new Error(`cannot extract <style>/<body> from ${sourcePath}`)

/* ------------------------------------------------------------------ markup */

let html = bodyMatch[1]
  .replace(/<script>[\s\S]*?<\/script>/g, '')
  .trim()

// The page draws its icons through <symbol> + <use href="#…">. A fragment
// lookup inside a shadow tree is not portable, so inline every symbol at build
// time: same markup, no cross-tree reference.
const spriteMatch = html.match(/<svg[^>]*class="icon-defs"[^>]*>([\s\S]*?)<\/svg>/)
if (!spriteMatch) throw new Error('cannot find the icon-defs SVG sprite')
const spriteInner = spriteMatch[1]
const symbols = new Map()
for (const match of spriteInner.matchAll(/<symbol id="([^"]+)" viewBox="([^"]+)">([\s\S]*?)<\/symbol>/g)) {
  symbols.set(match[1], { viewBox: match[2], inner: match[3].trim() })
}
if (!symbols.size) throw new Error('no <symbol> definitions found')

html = html.replace(/<svg([^>]*)><use href="#([^"]+)"\s*\/><\/svg>/g, (whole, attrs, symbolId) => {
  const symbol = symbols.get(symbolId)
  if (!symbol) return whole
  const viewBox = /\bviewBox=/.test(attrs) ? '' : ` viewBox="${symbol.viewBox}"`
  return `<svg${attrs}${viewBox}>${symbol.inner}</svg>`
})
html = html.replace(spriteMatch[0], '')

// A confirmation dialog replaces window.confirm(), which is unreliable in the
// desktop shell and cannot be styled from a shadow tree.
html += `
<div class="dfy-confirm" id="dfy-confirm" hidden>
  <div class="dfy-confirm-card" role="dialog" aria-modal="true" aria-labelledby="dfy-confirm-text">
    <p id="dfy-confirm-text"></p>
    <div class="dfy-confirm-actions">
      <button type="button" class="ghost-btn" id="dfy-confirm-cancel">取消</button>
      <button type="button" class="primary" id="dfy-confirm-ok">确定</button>
    </div>
  </div>
</div>`

/* ---------------------------------------------------------------------- css */

let css = styleMatch[1]

// `:root` / `html` / `body` never match inside a shadow tree: move the page
// shell onto the wrapper element instead.
css = css.replace(/:root\s*\{/g, '.dfy-page {')
css = css.replace(/\bhtml\s*,\s*body\s*\{/g, '.dfy-page {')
css = css.replace(/(^|\n)(\s*)body\s*\{/g, '$1$2.dfy-page {')
// The demo's embed switch has no meaning inside the panel: the shell is not
// part of this page at all.
css = css.replace(/body\.embed[^{]*\{[^}]*\}/g, '')

// The chat UI was laid out against the window. Inside a Harness panel the
// available width is the pane, so breakpoints become container queries and
// viewport-relative sizes follow the pane (cqw).
css = css.replace(/@media\s*\(max-width:\s*(\d+)px\)\s*and\s*\(min-width:\s*(\d+)px\)/g, '@container (max-width: $1px) and (min-width: $2px)')
css = css.replace(/@media\s*\(max-width:\s*(\d+)px\)/g, '@container (max-width: $1px)')
css = css.replace(/(\d+(?:\.\d+)?)vw\b/g, '$1cqw')
// A container query cannot style its own container; the design's breakpoint
// overrides for --stage must land on a descendant instead.
css = css.replace(/\.dfy-page\s*\{--stage:([^}]*)\}/g, '.dfy-page .app{--stage:$1}')

// The demo's chrome (modal, toast, confirm) is viewport-fixed; in the panel it
// belongs to the pane, and the pane — not a floating window — owns the wrapper.
css += `
:host { display:block; height:100%; min-height:0; }
.dfy-page { position:relative; container-type:inline-size; height:100%; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
.dfy-page > .app { flex:1 1 auto; width:100%; height:100%; min-height:0; max-height:none; overflow:hidden; }
.dfy-page .modal-backdrop { position:absolute; }
.dfy-page .toast { position:absolute; }
.dfy-page .dfy-confirm { position:absolute; }
`

/* ------------------------------------------------------------------ runtime */

const runtime = readFileSync(join(here, 'src/runtime.js'), 'utf8')

/* -------------------------------------------------------------- client.js */

const moduleSource = `/**
 * 大肥鱼 · chat UI — browser half.
 *
 * Registers one sidebar panel entry (\`sidebar.panellist\`) and the matching
 * main panel (\`main\`). The panel renders the ported chat design inside a
 * Shadow DOM subtree: the concept UI keeps its own palette and its generic class
 * names (.app/.message/…) never reach the Harness stylesheet. Chat data lives in
 * the DSH Session log; the panel's own state (persona/name, wallet, ledger)
 * stays in this browser's localStorage.
 *
 * While active, the module also stacks the fish-pond palette onto the Harness
 * theme as a token override layer, so the whole application — not just this
 * panel — picks up the little-pond blue tone in light and dark mode. The base
 * theme and the user's light/dark preference stay untouched.
 *
 * Generated by build.mjs from src/original.html + src/runtime.js — edit those.
 */
window.__ModuleLoader__.load({
  id: '@local/chonkyfish-dashboard',
  factory: function (require) {
    var React = require('react')
    var h = React.createElement

    var NS = 'chonkyfish'

    var zh = {
      nav: '大肥鱼',
      title: '大肥鱼 · 小鱼塘管理台',
    }
    var en = {
      nav: 'ChonkyFish',
      title: 'ChonkyFish · Little Fish Pond',
    }

    var CSS = ${JSON.stringify(css)}
    var PAGE_HTML = ${JSON.stringify(html)}
    var PET_AVATAR = ${JSON.stringify(assets.avatar)}
    var PET_POSES = ${JSON.stringify(assets.poses)}

    /**
     * The Harness-wide skin. Every Web UI colour derives from the static palette
     * (--dsw-static-*) that the light and dark alias maps both reference:
     * bg-base ← neutral-bluish-00 / -950, labels ← the scale ends, links ←
     * deepseek-*, states ← green/red/amber, and so on. Retinting that palette
     * therefore re-tints every surface, border, label, link, state and menu at
     * once — including the ~100 tokens the 14-name Theme inspect directory does
     * not list. A handful of alias tokens carrying literal colours (borders,
     * menu material, diff fills) are set explicitly. The layer composes over the
     * built-in light/dark themes; the preference is untouched and unload restores
     * the original palette.
     */
    var SKIN_SOURCE = '@local/chonkyfish-dashboard'
    var SKIN = {
      // neutral-bluish scale: surfaces, borders, every label
      '--dsw-static-neutral-bluish-50': { light: '#f5faff', dark: '#f5faff' },
      '--dsw-static-neutral-bluish-60': { light: '#f1f8ff', dark: '#f1f8ff' },
      '--dsw-static-neutral-bluish-75': { light: '#edf6ff', dark: '#edf6ff' },
      '--dsw-static-neutral-bluish-100': { light: '#e6f0fb', dark: '#e6f0fb' },
      '--dsw-static-neutral-bluish-150': { light: '#e1edfa', dark: '#e1edfa' },
      '--dsw-static-neutral-bluish-200': { light: '#d8e7f6', dark: '#d8e7f6' },
      '--dsw-static-neutral-bluish-300': { light: '#c2d5e8', dark: '#c2d5e8' },
      '--dsw-static-neutral-bluish-400': { light: '#9db4cc', dark: '#9db4cc' },
      '--dsw-static-neutral-bluish-500': { light: '#8099b4', dark: '#8099b4' },
      '--dsw-static-neutral-bluish-600': { light: '#5b7794', dark: '#5b7794' },
      '--dsw-static-neutral-bluish-700': { light: '#56748f', dark: '#56748f' },
      '--dsw-static-neutral-bluish-750': { light: '#445e77', dark: '#445e77' },
      '--dsw-static-neutral-bluish-800': { light: '#354d63', dark: '#354d63' },
      '--dsw-static-neutral-bluish-850': { light: '#2b3f53', dark: '#2b3f53' },
      '--dsw-static-neutral-bluish-875': { light: '#223447', dark: '#223447' },
      '--dsw-static-neutral-bluish-900': { light: '#1a2a3b', dark: '#1a2a3b' },
      '--dsw-static-neutral-bluish-950': { light: '#0e1a29', dark: '#0e1a29' },
      '--dsw-static-neutral-bluish-1000': { light: '#283d59', dark: '#283d59' },
      '--dsw-static-neutral-bluish-00': { light: '#ffffff', dark: '#ffffff' },
      // neutral scale: inline code, scrollbars, idle states
      '--dsw-static-neutral-50': { light: '#fafdff', dark: '#fafdff' },
      '--dsw-static-neutral-100': { light: '#f4f9ff', dark: '#f4f9ff' },
      '--dsw-static-neutral-150': { light: '#ecf3fb', dark: '#ecf3fb' },
      '--dsw-static-neutral-200': { light: '#e3ecf7', dark: '#e3ecf7' },
      '--dsw-static-neutral-250': { light: '#dae6f3', dark: '#dae6f3' },
      '--dsw-static-neutral-300': { light: '#d2e0ef', dark: '#d2e0ef' },
      '--dsw-static-neutral-400': { light: '#a5b8cc', dark: '#a5b8cc' },
      '--dsw-static-neutral-500': { light: '#7f97ae', dark: '#7f97ae' },
      '--dsw-static-neutral-550': { light: '#657f97', dark: '#657f97' },
      '--dsw-static-neutral-600': { light: '#546b82', dark: '#546b82' },
      '--dsw-static-neutral-700': { light: '#3c5268', dark: '#3c5268' },
      '--dsw-static-neutral-800': { light: '#293d51', dark: '#293d51' },
      '--dsw-static-neutral-850': { light: '#213345', dark: '#213345' },
      '--dsw-static-neutral-900': { light: '#0f1c2a', dark: '#0f1c2a' },
      '--dsw-static-neutral-1000': { light: '#06101a', dark: '#06101a' },
      '--dsw-static-neutral-00': { light: '#ffffff', dark: '#ffffff' },
      // blue scale: selections and blue accents
      '--dsw-static-blue-50': { light: '#f2f8ff', dark: '#f2f8ff' },
      '--dsw-static-blue-75': { light: '#e8f3ff', dark: '#e8f3ff' },
      '--dsw-static-blue-100': { light: '#e0f0ff', dark: '#e0f0ff' },
      '--dsw-static-blue-300': { light: '#a8cef1', dark: '#a8cef1' },
      '--dsw-static-blue-400': { light: '#7db4e8', dark: '#7db4e8' },
      '--dsw-static-blue-450': { light: '#68a3e0', dark: '#68a3e0' },
      '--dsw-static-blue-500': { light: '#4f92d4', dark: '#4f92d4' },
      '--dsw-static-blue-600': { light: '#3a7cbf', dark: '#3a7cbf' },
      '--dsw-static-blue-800': { light: '#245a94', dark: '#245a94' },
      '--dsw-static-blue-900': { light: '#1c4f7e', dark: '#1c4f7e' },
      '--dsw-static-blue-950': { light: '#15293f', dark: '#15293f' },
      '--dsw-static-blue-50p': { light: '#edf5ff', dark: '#edf5ff' },
      // deepseek scale: links, focus ring, business state
      '--dsw-static-deepseek-50': { light: '#f0f7ff', dark: '#f0f7ff' },
      '--dsw-static-deepseek-100': { light: '#e5f1fd', dark: '#e5f1fd' },
      '--dsw-static-deepseek-200': { light: '#cfe3f7', dark: '#cfe3f7' },
      '--dsw-static-deepseek-300': { light: '#b3d2ee', dark: '#b3d2ee' },
      '--dsw-static-deepseek-400': { light: '#75b0e8', dark: '#75b0e8' },
      '--dsw-static-deepseek-450': { light: '#5b9ede', dark: '#5b9ede' },
      '--dsw-static-deepseek-500': { light: '#3273bd', dark: '#3273bd' },
      '--dsw-static-deepseek-600': { light: '#3f6da8', dark: '#3f6da8' },
      '--dsw-static-deepseek-800': { light: '#344a63', dark: '#344a63' },
      '--dsw-static-deepseek-900': { light: '#283a4e', dark: '#283a4e' },
      '--dsw-static-deepseek-700-delete': { light: '#335f8c', dark: '#335f8c' },
      // green scale: success
      '--dsw-static-green-100': { light: '#e5f8ef', dark: '#e5f8ef' },
      '--dsw-static-green-400': { light: '#5fb894', dark: '#5fb894' },
      '--dsw-static-green-500': { light: '#2f8a68', dark: '#2f8a68' },
      '--dsw-static-green-900': { light: '#1f3a30', dark: '#1f3a30' },
      '--dsw-static-green-500-a08': { light: '#2f8a6814', dark: '#2f8a6814' },
      '--dsw-static-green-500-a12': { light: '#2f8a681f', dark: '#2f8a681f' },
      // red scale: error
      '--dsw-static-red-50': { light: '#fff5f6', dark: '#fff5f6' },
      '--dsw-static-red-100': { light: '#ffe9ec', dark: '#ffe9ec' },
      '--dsw-static-red-400': { light: '#e88b96', dark: '#e88b96' },
      '--dsw-static-red-500': { light: '#d96a74', dark: '#d96a74' },
      '--dsw-static-red-600': { light: '#c0525c', dark: '#c0525c' },
      '--dsw-static-red-900': { light: '#4a2328', dark: '#4a2328' },
      '--dsw-static-red-400-a12': { light: '#e88b961f', dark: '#e88b961f' },
      '--dsw-static-red-600-a08': { light: '#c0525c14', dark: '#c0525c14' },
      // amber scale: warning
      '--dsw-static-amber-100': { light: '#fff2ce', dark: '#fff2ce' },
      '--dsw-static-amber-400': { light: '#d9a441', dark: '#d9a441' },
      '--dsw-static-amber-500': { light: '#96701c', dark: '#96701c' },
      '--dsw-static-amber-600': { light: '#8a6417', dark: '#8a6417' },
      '--dsw-static-amber-900': { light: '#3a2f1c', dark: '#3a2f1c' },
      // light-mode surfaces and primary action keep the pond blue visible
      '--dsw-alias-brand-primary': { light: '#3478c2', dark: '#f5faff' },
      '--dsw-alias-button-primary-hover': { light: '#2b66a8', dark: '#e6f0fb' },
      '--dsw-alias-bg-layer-2': { light: '#f5faff', dark: '#2b3f53' },
      '--dsw-specific-sidebar-fill': { light: '#eaf4ff', dark: '#1a2a3b' },
      // chrome: borders, menu material, brand sparkle, diff fills
      '--dsw-alias-border-l1': { light: '#2b4a7012', dark: '#ffffff0f' },
      '--dsw-alias-border-l2': { light: '#2b4a701f', dark: '#ffffff1f' },
      '--dsw-alias-border-l2-darkmode-thin': { light: '#2b4a701f', dark: '#ffffff0f' },
      '--dsw-alias-border-l3': { light: '#2b4a7026', dark: '#ffffff29' },
      '--dsw-alias-border-l4': { light: '#2b4a7033', dark: '#ffffff33' },
      '--dsw-alias-brand-primary-new-colorprimary-new-color': { light: '#3478c2', dark: '#5b9ede' },
      '--dsw-menu-surface-fill': { light: '#f8fbff94', dark: '#14243273' },
      '--dsw-alias-menu-group-header-fill': { light: '#f8fbfff0', dark: '#11202ff0' },
      '--dsw-specific-menu': { light: '#f8fbfff0', dark: '#162433f0' },
      '--dsw-alias-label-document-preview': { light: '#4a637c', dark: '#c2d5e8' },
      '--dsw-alias-file-diff-added-bg': { light: '#e6f6ee', dark: '#16302a' },
      '--dsw-alias-file-diff-added-gutter': { light: '#eef9f3', dark: '#122720' },
      '--dsw-alias-file-diff-added-marker': { light: '#2f8a68', dark: '#63c79e' },
      '--dsw-alias-file-diff-deleted-bg': { light: '#fdeef0', dark: '#33201f' },
      '--dsw-alias-file-diff-deleted-gutter': { light: '#fdf4f5', dark: '#281a1a' },
      '--dsw-alias-file-diff-deleted-marker': { light: '#c0525c', dark: '#f0909a' },
    }

${runtime}

    /**
     * Bridge between the fish panel and a real DSH Session.
     *
     * The panel lives in a root-scoped 'main' cell, so it gets no Session of its
     * own. This bridge creates (or reuses) one chat-only Session under the
     * "chonkyfish" agent preset, keeps a Client reference to it, sends prompts
     * through the Session API, and turns the Session event window into bubbles.
     * The Session log stays the source of truth; nothing is copied into
     * localStorage except the Session id.
     */
    var fishChat = null

    function createFishChat(ctx) {
      var SESSION_KEY = 'chonkyfish-session-v2'
      var LEGACY_SESSION_KEY = 'chonkyfish-session-v1'
      var WORKSPACE_KEY = 'chonkyfish-workspace-v1'
      var POND_DIR_NAME = '小鱼塘'
      var PRESET = 'chonkyfish'
      var listeners = new Set()
      var status = { phase: 'idle', error: null }
      var reference = null
      var binding = null
      var ensurePromise = null
      var unsubscribes = []
      var disposed = false
      var messageCache = { revision: -1, list: [] }
      var fishWorkspaceId = null
      var workspacePromise = null

      function emit() {
        listeners.forEach(function (listener) {
          try {
            listener()
          } catch (error) {
            console.error('[chonkyfish] chat listener failed', error)
          }
        })
      }
      function setStatus(phase, error) {
        status = { phase: phase, error: error || null }
        emit()
      }
      function readStoredId() {
        try {
          return localStorage.getItem(SESSION_KEY)
        } catch (error) {
          return null
        }
      }
      function storeId(id) {
        try {
          localStorage.setItem(SESSION_KEY, id)
        } catch (error) {
          /* keep the live reference even when storage is blocked */
        }
      }
      function forgetStoredId() {
        try {
          localStorage.removeItem(SESSION_KEY)
        } catch (error) {
          /* ignore */
        }
      }
      function migrateLegacySession() {
        try {
          var legacy = localStorage.getItem(LEGACY_SESSION_KEY)
          if (!legacy) return
          localStorage.removeItem(LEGACY_SESSION_KEY)
          try {
            Promise.resolve(ctx.workspaces.archiveSession(legacy, { stopActivity: true })).catch(function () {})
          } catch (error) {
            /* archiving is best-effort */
          }
        } catch (error) {
          /* storage unavailable */
        }
      }
      function readWorkspaceId() {
        try {
          return localStorage.getItem(WORKSPACE_KEY)
        } catch (error) {
          return null
        }
      }
      function rememberWorkspaceId(id) {
        try {
          localStorage.setItem(WORKSPACE_KEY, id)
        } catch (error) {
          /* ignore */
        }
      }
      function listedWorkspaces() {
        try {
          var snapshot = ctx.workspaces.list.getSnapshot()
          return (snapshot && snapshot.items) || []
        } catch (error) {
          return []
        }
      }
      function knownWorkspace(id) {
        if (!id) return false
        var items = listedWorkspaces()
        for (var i = 0; i < items.length; i += 1) {
          if (items[i] && items[i].workspaceId === id) return true
        }
        return false
      }
      function hostHome() {
        try {
          var host = ctx.remote && ctx.remote.$host
          return host && typeof host.home === 'string' ? host.home : null
        } catch (error) {
          return null
        }
      }
      async function ensureFishWorkspace() {
        if (fishWorkspaceId && knownWorkspace(fishWorkspaceId)) return fishWorkspaceId
        if (workspacePromise) return workspacePromise
        workspacePromise = (async function () {
          var stored = readWorkspaceId()
          if (stored && knownWorkspace(stored)) {
            fishWorkspaceId = stored
            return stored
          }
          var home = hostHome()
          if (!home) return undefined
          var base = home.replace(/[\/]+$/, '') + '/.dsh'
          var path = base + '/' + POND_DIR_NAME
          var items = listedWorkspaces()
          for (var i = 0; i < items.length; i += 1) {
            if (items[i] && items[i].path === path) {
              fishWorkspaceId = items[i].workspaceId
              rememberWorkspaceId(fishWorkspaceId)
              return fishWorkspaceId
            }
          }
          try {
            await ctx.uiWorkspace.createDirectory(base, POND_DIR_NAME)
          } catch (error) {
            /* the folder may already exist; creating the workspace adopts it */
          }
          var created = await ctx.workspaces.create({ path: path })
          var workspaceId = created && created.workspaceId
          if (!workspaceId) throw new Error('创建小鱼塘工作区失败')
          fishWorkspaceId = workspaceId
          rememberWorkspaceId(workspaceId)
          return workspaceId
        })()
        try {
          return await workspacePromise
        } catch (error) {
          workspacePromise = null
          fishWorkspaceId = null
          throw error
        }
      }
      function workspaceIdForChat() {
        try {
          var workspaceState = ctx.workspaces.list.getSnapshot()
          var workspaces = (workspaceState && workspaceState.items) || []
          if (!workspaces.length) return undefined
          var sessionState = ctx.sessions.list.getSnapshot()
          var ids = (sessionState && sessionState.ids) || []
          var newest = null
          for (var i = 0; i < ids.length; i += 1) {
            var summary = sessionState.byId[ids[i]]
            if (!summary || summary.removed) continue
            var stamp = summary.updatedAt || summary.createdAt || 0
            if (!newest || stamp > (newest.updatedAt || newest.createdAt || 0)) newest = summary
          }
          if (newest && newest.cwd) {
            for (var j = 0; j < workspaces.length; j += 1) {
              if (workspaces[j].path === newest.cwd) return workspaces[j].workspaceId
            }
          }
          return workspaces[0].workspaceId
        } catch (error) {
          console.error('[chonkyfish] cannot resolve a workspace', error)
          return undefined
        }
      }
      function textOfBlocks(blocks) {
        if (!Array.isArray(blocks)) return ''
        var text = ''
        for (var i = 0; i < blocks.length; i += 1) {
          var block = blocks[i]
          if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
        }
        return text
      }
      function displayText(role, text) {
        if (role !== 'user') return text
        var PREFIX = '【角色补充设定】'
        var MARKER = '【用户消息】'
        if (text.indexOf(PREFIX) !== 0) return text
        var markerIndex = text.indexOf(MARKER)
        if (markerIndex === -1) return text
        var rest = text.slice(markerIndex + MARKER.length)
        if (rest.charAt(0) === '\\n') rest = rest.slice(1)
        return rest
      }
      function timeOf(ms) {
        try {
          return new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
        } catch (error) {
          return ''
        }
      }
      function getMessages() {
        if (!binding) return []
        var windowSnapshot = binding.eventSource.getSnapshot()
        if (!windowSnapshot || !Array.isArray(windowSnapshot.entries)) return []
        if (windowSnapshot.revision === messageCache.revision) return messageCache.list
        var out = []
        for (var i = 0; i < windowSnapshot.entries.length; i += 1) {
          var entry = windowSnapshot.entries[i]
          var event = entry && entry.event
          if (!event) continue
          var role
          var raw
          if (event.type === 'user/message') {
            var source = event.data && event.data.source
            if (!source || source.kind !== 'user') continue
            role = 'user'
            raw = textOfBlocks(event.data && event.data.content)
          } else if (event.type === 'assistant/message') {
            role = 'fish'
            raw = textOfBlocks(event.data && event.data.message && event.data.message.content)
          } else {
            continue
          }
          if (!raw) continue
          if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') continue
          out.push({ role: role, text: displayText(role, raw), time: timeOf(event.time) })
        }
        messageCache = { revision: windowSnapshot.revision, list: out }
        return out
      }
      function isRunning() {
        if (!binding) return false
        try {
          return binding.session.getSnapshot().running === true
        } catch (error) {
          return false
        }
      }
      function attach(nextReference) {
        reference = nextReference
        binding = nextReference.binding
        unsubscribes.push(binding.eventSource.subscribe(emit))
        unsubscribes.push(binding.session.subscribe(emit))
      }
      function releaseReference() {
        for (var i = 0; i < unsubscribes.length; i += 1) {
          try {
            unsubscribes[i]()
          } catch (error) {
            /* ignore */
          }
        }
        unsubscribes = []
        if (reference) {
          try {
            reference.release()
          } catch (error) {
            /* ignore */
          }
        }
        reference = null
        binding = null
      }
      async function ensure() {
        if (disposed) throw new Error('大肥鱼面板已关闭')
        if (binding) return binding
        if (ensurePromise) return ensurePromise
        ensurePromise = (async function () {
          setStatus('connecting')
          migrateLegacySession()
          var pondWorkspaceId
          try {
            pondWorkspaceId = await ensureFishWorkspace()
          } catch (error) {
            console.warn('[chonkyfish] 小鱼塘工作区创建失败，暂时使用最近的项目', error)
          }
          var stored = readStoredId()
          if (stored) {
            try {
              var existing = ctx.sessions.retain(stored, { source: 'controllerOperation' })
              await existing.ready
              attach(existing)
              setStatus('ready')
              return binding
            } catch (error) {
              forgetStoredId()
            }
          }
          var workspaceId = pondWorkspaceId || workspaceIdForChat()
          if (!workspaceId) throw new Error('找不到可用的 DSH 工作区')
          var created = await ctx.uiWorkspace.connectWorkspace(workspaceId, { agentPreset: PRESET })
          storeId(created)
          var next = ctx.sessions.retain(created, { source: 'controllerOperation' })
          await next.ready
          attach(next)
          setStatus('ready')
          return binding
        })()
        try {
          return await ensurePromise
        } catch (error) {
          setStatus('error', error)
          ensurePromise = null
          throw error
        }
      }
      async function send(text) {
        var current = await ensure()
        var result = await current.session.prompt([{ type: 'text', text: text }], 'queue')
        if (!result || result.ok !== true) {
          var failure = result && result.error
          throw new Error(failure && (failure.message || failure.code) ? failure.message || failure.code : '发送失败')
        }
      }
      async function reset() {
        releaseReference()
        forgetStoredId()
        ensurePromise = null
        messageCache = { revision: -1, list: [] }
        setStatus('idle')
        return ensure()
      }
      function onChange(listener) {
        listeners.add(listener)
        return function () {
          listeners.delete(listener)
        }
      }
      function getStatus() {
        return status
      }
      function dispose() {
        disposed = true
        releaseReference()
        listeners.clear()
        ensurePromise = null
      }
      return {
        ensure: ensure,
        send: send,
        reset: reset,
        getMessages: getMessages,
        isRunning: isRunning,
        getStatus: getStatus,
        onChange: onChange,
        dispose: dispose,
      }
    }

    /** The main panel: mounts the ported page into a shadow tree. */
    function ChonkyFishPage() {
      var hostRef = React.useRef(null)

      React.useEffect(function () {
        var host = hostRef.current
        if (!host) return undefined
        var shadow
        try {
          shadow = host.shadowRoot || host.attachShadow({ mode: 'open' })
        } catch (error) {
          console.error('[chonkyfish] shadow root unavailable', error)
          host.textContent = '大肥鱼面板无法初始化：当前浏览器不支持 Shadow DOM。'
          return undefined
        }

        shadow.innerHTML = ''
        var style = document.createElement('style')
        style.textContent = CSS
        var wrap = document.createElement('div')
        wrap.className = 'dfy-page'
        wrap.innerHTML = PAGE_HTML
        shadow.appendChild(style)
        shadow.appendChild(wrap)

        var dispose = function () {}
        try {
          dispose = mountChonkyFishPage(wrap, fishChat) || dispose
        } catch (error) {
          console.error('[chonkyfish] page mount failed', error)
          wrap.textContent = '大肥鱼面板初始化失败：' + (error && error.message ? error.message : String(error))
        }

        return function () {
          try {
            dispose()
          } catch (error) {
            console.error('[chonkyfish] page dispose failed', error)
          }
          shadow.innerHTML = ''
        }
      }, [])

      return h('div', {
        ref: hostRef,
        className: 'chonkyfish-host',
        style: { display: 'block', height: '100%', minHeight: 0, overflow: 'hidden' },
      })
    }

    /** The sidebar entry: a fish glyph that follows the host's icon color. */
    function ChonkyFishIcon(props) {
      var size = (props && props.size) || 18
      var active = props && props.active === true
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        'aria-hidden': true,
        focusable: false,
        style: { display: 'block', opacity: active ? 1 : 0.82 },
      },
        h('path', {
          fill: 'currentColor',
          fillRule: 'evenodd',
          clipRule: 'evenodd',
          d: 'M2.6 12.2c2.3 3.9 6 6.1 9.9 6.1 4.7 0 8.1-3 9.2-6.1-1.1-3.1-4.5-6.1-9.2-6.1-3.9 0-7.6 2.2-9.9 6.1Zm15 0a1.4 1.4 0 1 1-2.8 0 1.4 1.4 0 0 1 2.8 0Z',
        }),
        h('path', {
          fill: 'currentColor',
          d: 'M8.3 6.5c-.8-1.5-.7-2.6.4-3.5.3 1.1.9 1.7 1.7 2.1a8.6 8.6 0 0 1-2.1 1.4Z',
        })
      )
    }

    function apply(ctx) {
      var t = ctx.locale.bind(NS)

      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en })
      }, 'chonkyfish: dictionaries')

      // Real DSH chat bridge: one chat-only Session under the "chonkyfish"
      // agent preset. The Session log owns the messages; this layer only keeps
      // a Client reference while the plugin is mounted.
      var chatBridge = createFishChat(ctx)
      fishChat = chatBridge
      ctx.effect(function () {
        return function () {
          chatBridge.dispose()
          if (fishChat === chatBridge) fishChat = null
        }
      }, 'chonkyfish: DSH chat bridge')

      // Skin the whole harness: one token override layer under this plugin's
      // id. Disposing the effect (plugin unload) removes exactly this layer.
      ctx.effect(function () {
        return ctx.theme.overrideTokens(SKIN_SOURCE, SKIN)
      }, 'chonkyfish: fish-pond skin')

      ctx.slots.inject('main', function () {
        return ctx.slots.register({
          name: 'main',
          key: 'chonkyfish',
          locale: NS,
        }, ChonkyFishPage)
      })

      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'chonkyfish',
          order: 20,
          label: function () { return t('nav') },
          locale: NS,
        }, ChonkyFishIcon)
      })
    }

    return { apply: apply, inject: ['slots', 'locale', 'theme', 'sessions', 'workspaces', 'uiWorkspace', 'remote'] }
  },
})
`

writeFileSync(join(here, 'client.js'), moduleSource)
console.log(`client.js written (${(moduleSource.length / 1024).toFixed(1)} KiB) from ${sourcePath}`)
