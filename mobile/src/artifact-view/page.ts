// An HTML file of an artifact as the phone's web view gets it. The desktop serves each file from an
// origin of its own (src/main/artifacts/protocol.ts); a web view here has no way to answer requests,
// so the page is made whole instead: what `servedHtml` serves everywhere (the source marks, the page
// runtime over a port, one canvas page alone), then the version's files put in where the page names
// them, and a prelude that holds the artifact policy, the files a script asks for, and the catch of
// links. The page then runs in a sandboxed frame of the viewer's shell (shell.ts).
//
// What a page names by a relative path:
//   images, media and fonts     data: URLs, which the artifact policy lets pages load
//   style sheets                inlined as <style>, since the policy allows inline styles only
//   classic scripts             inlined as <script>
//   module scripts              inlined; their imports and the page's own go through an import map
//                               of blob: URLs that the prelude makes
//   fetch()                     answered by the prelude from the version's files
//   links to other pages        opened by the viewer; links out of the artifact, after it asks
// Every other relative URL resolves to VIRTUAL_ORIGIN, which no network has and the policy blocks.

import { ARTIFACT_ENTRY, artifactFileType, isHtmlPath, isTextType } from '@shared/artifact-files'
import { servedHtml, type CanvasPage } from '@shared/artifact-page'
import { ARTIFACT_CSP } from '@shared/artifact-policy'
import { decodeText, eachStartTag, type StartTag } from '@shared/artifact-source'
import { dataUrl, textOf, toBase64 } from './bytes'
import type { LoadedFile, LoadedVersion } from './content'

/** The made-up origin a page's relative URLs resolve to; `.invalid` never resolves. */
export const VIRTUAL_ORIGIN = 'https://artifact.invalid'

/** Binary files a page may also fetch by script, while the version stays under this. */
const EMBED_BINARY_BYTES = 12 * 1024 * 1024
const MAX_CSS_DEPTH = 6

/** The artifact path a reference from `from` names, with its fragment; null for a URL elsewhere. */
export function resolveRef(from: string, ref: string): { path: string; hash: string } | null {
  let rest = ref.trim()
  if (rest.startsWith(VIRTUAL_ORIGIN + '/')) rest = rest.slice(VIRTUAL_ORIGIN.length)
  else if (/^[a-z][a-z0-9+.-]*:/i.test(rest) || rest.startsWith('//')) return null
  const hashAt = rest.indexOf('#')
  const hash = hashAt >= 0 ? rest.slice(hashAt) : ''
  if (hashAt >= 0) rest = rest.slice(0, hashAt)
  const queryAt = rest.indexOf('?')
  if (queryAt >= 0) rest = rest.slice(0, queryAt)
  if (rest === '') return { path: from, hash }
  let decoded: string
  try {
    decoded = decodeURIComponent(rest)
  } catch {
    return null
  }
  const segments = decoded.startsWith('/') ? [] : from.split('/').slice(0, -1)
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return null
      segments.pop()
    } else segments.push(segment)
  }
  const folder = decoded.endsWith('/') || decoded === '' || segments.length === 0
  if (folder) segments.push(ARTIFACT_ENTRY)
  return { path: segments.join('/'), hash }
}

/** The virtual URL of a file, as the page's own relative URLs resolve. */
export function virtualUrl(path: string): string {
  return `${VIRTUAL_ORIGIN}/${path.split('/').map(encodeURIComponent).join('/')}`
}

function folderUrl(path: string): string {
  const folder = path.split('/').slice(0, -1)
  return `${VIRTUAL_ORIGIN}/${folder.map((s) => `${encodeURIComponent(s)}/`).join('')}`
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

/** Code safe inside a script element: no end tag of one, however it is spelled. */
function scriptText(code: string): string {
  return code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--')
}

function styleText(css: string): string {
  return css.replace(/<\/(style)/gi, '<\\/$1')
}

/** JSON for inside a script element. */
function json(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

const MODULE_SPECIFIER =
  /(\bimport\s*\(\s*|\bimport\s+|\bfrom\s+|\bexport\s*\*\s*from\s+)(['"])(\.{1,2}\/[^'"\n]*|\/[^'"\n/][^'"\n]*)\2/g

class PageBuilder {
  private readonly urls = new Map<string, string>()
  private readonly sheets = new Map<string, string>()
  private readonly modules = new Map<string, string>()
  private readonly files: ReadonlyMap<string, LoadedFile>
  usesModules = false

  constructor(files: ReadonlyMap<string, LoadedFile>) {
    this.files = files
  }

  file(path: string): LoadedFile | null {
    return this.files.get(path) ?? null
  }

  /** A data: URL for an image, a medium or a font. */
  url(file: LoadedFile): string {
    let url = this.urls.get(file.path)
    if (url === undefined) {
      url = dataUrl(file.type, file.bytes)
      this.urls.set(file.path, url)
    }
    return url
  }

  /** A style sheet with what it names put in: url() as data, @import inlined. */
  css(path: string, depth: number): string {
    const kept = this.sheets.get(path)
    if (kept !== undefined) return kept
    const file = this.file(path)
    if (!file) return ''
    this.sheets.set(path, '')
    const out = this.cssText(textOf(file.bytes), path, depth)
    this.sheets.set(path, out)
    return out
  }

  cssText(css: string, from: string, depth: number): string {
    const imported = css.replace(
      /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?\s*([^;]*);/gi,
      (whole, _quote: string, ref: string, media: string) => {
        const found = resolveRef(from, ref)
        if (!found || !this.file(found.path) || depth >= MAX_CSS_DEPTH) return whole
        const inner = this.css(found.path, depth + 1)
        return media.trim() ? `@media ${media.trim()}{${inner}}` : inner
      },
    )
    return imported.replace(
      /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
      (whole, _quote: string, ref: string) => {
        const found = resolveRef(from, ref)
        const file = found ? this.file(found.path) : null
        return file && !file.type.startsWith('text/css') ? `url("${this.url(file)}")` : whole
      },
    )
  }

  /** A module's code with its relative imports made absolute, for the import map to find. */
  module(path: string): string {
    let code = this.modules.get(path)
    if (code === undefined) {
      const file = this.file(path)
      code = file
        ? textOf(file.bytes).replace(
            MODULE_SPECIFIER,
            (whole, head: string, quote: string, ref: string) => {
              const found = resolveRef(path, ref)
              return found && this.file(found.path)
                ? `${head}${quote}${virtualUrl(found.path)}${quote}`
                : whole
            },
          )
        : ''
      this.modules.set(path, code)
    }
    return code
  }

  /** `srcset`'s candidates, each URL that names a file put in. */
  srcset(from: string, value: string): string {
    return value
      .split(',')
      .map((candidate) => {
        const parts = candidate.trim().split(/\s+/)
        const found = parts[0] ? resolveRef(from, parts[0]) : null
        const file = found ? this.file(found.path) : null
        if (file) parts[0] = this.url(file)
        return parts.join(' ')
      })
      .join(', ')
  }
}

function attribute(tag: StartTag, name: string): string | null {
  const found = tag.attributes.find((a) => a.name === name)
  return found ? decodeText(found.value ?? '') : null
}

const SRC_TAGS = new Set(['img', 'source', 'audio', 'video', 'track', 'embed', 'input', 'image'])

interface Edit {
  start: number
  end: number
  text: string
}

/** The served HTML with the files it names put in place. */
function inline(html: string, path: string, builder: PageBuilder): string {
  const edits: Edit[] = []
  const deferred: string[] = []
  const replaceAttribute = (tag: StartTag, name: string, value: string): void => {
    const found = tag.attributes.find((a) => a.name === name)
    if (found)
      edits.push({
        start: found.start,
        end: found.end,
        text: `${name}="${escapeAttribute(value)}"`,
      })
  }
  const dropAttribute = (tag: StartTag, name: string): void => {
    const found = tag.attributes.find((a) => a.name === name)
    if (found) edits.push({ start: found.start, end: found.end, text: '' })
  }
  const fileAt = (ref: string | null): LoadedFile | null => {
    const found = ref === null ? null : resolveRef(path, ref)
    return found ? builder.file(found.path) : null
  }

  eachStartTag(html, (tag) => {
    const style = attribute(tag, 'style')
    if (style !== null && /url\(/i.test(style)) {
      replaceAttribute(tag, 'style', builder.cssText(style, path, 0))
    }
    switch (tag.name) {
      case 'script': {
        const type = (attribute(tag, 'type') ?? '').trim().toLowerCase()
        const isModule = type === 'module'
        if (isModule) builder.usesModules = true
        if (type === 'importmap') return
        const file = fileAt(attribute(tag, 'src'))
        if (!file) return
        // The element's own text is ignored while it has a src, and it is text alone.
        const close = /<\/script[\s/>]/gi
        close.lastIndex = tag.end
        const end = close.exec(html)
        if (!end) return
        const code = isModule ? builder.module(file.path) : textOf(file.bytes)
        // An inline classic script runs where it stands, so a deferred one moves to the end of
        // the document, where it runs after parsing and before DOMContentLoaded, as defer does.
        if (!isModule && attribute(tag, 'defer') !== null && attribute(tag, 'async') === null) {
          const closeEnd = html.indexOf('>', end.index) + 1
          edits.push({ start: tag.start, end: closeEnd > 0 ? closeEnd : end.index, text: '' })
          deferred.push(`<script>${scriptText(code)}</script>`)
          return
        }
        dropAttribute(tag, 'src')
        dropAttribute(tag, 'integrity')
        edits.push({ start: tag.end, end: end.index, text: scriptText(code) })
        return
      }
      case 'link': {
        const rel = (attribute(tag, 'rel') ?? '').toLowerCase().split(/\s+/)
        const file = fileAt(attribute(tag, 'href'))
        if (!file) return
        if (rel.includes('stylesheet')) {
          const media = attribute(tag, 'media')
          const css = builder.css(file.path, 0)
          edits.push({
            start: tag.start,
            end: tag.end,
            text: `<style${media ? ` media="${escapeAttribute(media)}"` : ''}>${styleText(css)}</style>`,
          })
        } else if (rel.includes('icon') || rel.includes('preload')) {
          replaceAttribute(tag, 'href', builder.url(file))
        }
        return
      }
      case 'style': {
        const close = /<\/style[\s/>]/gi
        close.lastIndex = tag.end
        const end = close.exec(html)
        if (!end) return
        const css = html.slice(tag.end, end.index)
        if (/url\(|@import/i.test(css)) {
          edits.push({
            start: tag.end,
            end: end.index,
            text: styleText(builder.cssText(css, path, 0)),
          })
        }
        return
      }
      case 'object': {
        const file = fileAt(attribute(tag, 'data'))
        if (file) replaceAttribute(tag, 'data', builder.url(file))
        return
      }
    }
    if (SRC_TAGS.has(tag.name)) {
      for (const name of ['src', 'poster', 'href', 'xlink:href']) {
        const file = fileAt(attribute(tag, name))
        if (file && !isHtmlPath(file.path)) replaceAttribute(tag, name, builder.url(file))
      }
      const srcset = attribute(tag, 'srcset')
      if (srcset) replaceAttribute(tag, 'srcset', builder.srcset(path, srcset))
    }
  })

  edits.sort((a, b) => a.start - b.start)
  let out = ''
  let at = 0
  for (const edit of edits) {
    if (edit.start < at) continue
    out += html.slice(at, edit.start) + edit.text
    at = edit.end
  }
  out += html.slice(at)
  if (deferred.length === 0) return out
  const bodyEnd = out.toLowerCase().lastIndexOf('</body')
  return bodyEnd < 0
    ? out + deferred.join('')
    : out.slice(0, bodyEnd) + deferred.join('') + out.slice(bodyEnd)
}

/** The page's own import map, cut out to merge with the prelude's; null when it has none. */
function takeImportMap(html: string): { html: string; map: Record<string, unknown> | null } {
  let found: { start: number; end: number; text: string } | null = null
  eachStartTag(html, (tag) => {
    if (
      tag.name !== 'script' ||
      (attribute(tag, 'type') ?? '').trim().toLowerCase() !== 'importmap'
    ) {
      return
    }
    const close = /<\/script\s*>/gi
    close.lastIndex = tag.end
    const end = close.exec(html)
    if (end)
      found = {
        start: tag.start,
        end: end.index + end[0].length,
        text: html.slice(tag.end, end.index),
      }
    return false
  })
  const cut = found as { start: number; end: number; text: string } | null
  if (!cut) return { html, map: null }
  try {
    const map = JSON.parse(cut.text) as Record<string, unknown>
    return { html: html.slice(0, cut.start) + html.slice(cut.end), map }
  } catch {
    return { html, map: null }
  }
}

/**
 * The script that runs first in the page: the files a script may still ask for, as blob: URLs and
 * fetch() answers, the import map, and links handed to the viewer. Its values are checked paths
 * and the version's own bytes, set out as JSON.
 */
function preludeScript(options: {
  files: Record<string, [string, string]>
  modules: Record<string, string> | null
  imports: Record<string, string>
  scopes: Record<string, unknown> | null
  origin: string
  page: string
}): string {
  return `(()=>{
const F=${json(options.files)},M=${json(options.modules)},O=${json(options.origin)},PAGE=${json(options.page)};
const parentWindow=window.parent,post=(m)=>{try{parentWindow.postMessage(m,'*')}catch(e){}};
const blobs=new Map();
const pathOf=(u)=>{let url;try{url=new URL(String(u),document.baseURI)}catch(e){return null}if(url.origin!==O)return null;let p;try{p=decodeURIComponent(url.pathname.slice(1))}catch(e){return null}if(p===''||p.endsWith('/'))p+='index.html';return p};
const bytes=(b64)=>{const s=atob(b64),a=new Uint8Array(s.length);for(let i=0;i<s.length;i++)a[i]=s.charCodeAt(i);return a};
const blob=(p,code)=>{let b=blobs.get(p);if(!b){if(code!==undefined)b=new Blob([code],{type:'text/javascript'});else{const f=F[p];if(!f)return null;b=new Blob([bytes(f[1])],{type:f[0]})}blobs.set(p,b)}return b};
const urls=new Map(),urlOf=(p)=>{let u=urls.get(p);if(!u){const b=blob(p);if(!b)return null;u=URL.createObjectURL(b);urls.set(p,u)}return u};
if(M){const imports=${json(options.imports)};for(const p of Object.keys(M)){imports[O+'/'+p.split('/').map(encodeURIComponent).join('/')]=URL.createObjectURL(new Blob([M[p]],{type:'text/javascript'}))}
const map=document.createElement('script');map.type='importmap';map.textContent=JSON.stringify(${options.scopes ? `{imports,scopes:${json(options.scopes)}}` : '{imports}'});document.currentScript.after(map)}
const realFetch=window.fetch.bind(window);
window.fetch=function(input,init){const u=typeof input==='string'||input instanceof URL?String(input):input&&input.url;const p=u?pathOf(u):null;if(p===null)return realFetch(input,init);const b=blob(p);return Promise.resolve(b?new Response(b,{status:200,headers:{'Content-Type':b.type}}):new Response('',{status:404,statusText:'Not Found'}))};
const swap=(proto,name)=>{const d=proto&&Object.getOwnPropertyDescriptor(proto,name);if(!d||!d.set)return;Object.defineProperty(proto,name,{...d,set(v){const p=pathOf(v);const u=p===null?null:urlOf(p);d.set.call(this,u||v)}})};
for(const [c,n] of [[window.HTMLImageElement,'src'],[window.HTMLScriptElement,'src'],[window.HTMLSourceElement,'src'],[window.HTMLMediaElement,'src'],[window.HTMLMediaElement,'poster'],[window.HTMLVideoElement,'poster']])swap(c&&c.prototype,n);
const setAttr=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){if((n==='src'||n==='poster')&&!(this instanceof HTMLIFrameElement)){const p=pathOf(v);const u=p===null?null:urlOf(p);if(u)return setAttr.call(this,n,u)}return setAttr.call(this,n,v)};
window.open=function(u){if(u!==undefined&&u!==null&&String(u)!==''){const p=pathOf(u);if(p!==null)post({__huli:'open',path:p,hash:''});else{try{post({__huli:'link',href:new URL(String(u),document.baseURI).href})}catch(e){}}}return null};
addEventListener('click',(e)=>{if(e.defaultPrevented||e.button!==0)return;const t=e.target;const a=t&&t.closest?t.closest('a[href],area[href]'):null;if(!a)return;const raw=a.getAttribute('href')||'';if(/^\\s*javascript:/i.test(raw))return;e.preventDefault();if(raw.startsWith('#')){const id=decodeURIComponent(raw.slice(1));const el=id?document.getElementById(id)||document.getElementsByName(id)[0]:null;if(el)el.scrollIntoView();else if(!id)scrollTo(0,0);return}
const href=a.href;const p=pathOf(href);if(p===null){post({__huli:'link',href});return}const h=new URL(href).hash;if(p===PAGE&&h){const el=document.getElementById(decodeURIComponent(h.slice(1)));if(el)el.scrollIntoView();return}post({__huli:'open',path:p,hash:h})});
document.currentScript.remove()})()`
}

export interface BuiltPage {
  html: string
  /** The page asks for files this phone left out, being too large to embed. */
  partial: boolean
}

/**
 * The page at `path` in the version, whole, for the shell's frame; `page` shows one page of an old
 * canvas alone. Null when the version has no such HTML file.
 */
export function buildPage(
  version: LoadedVersion,
  path: string,
  page: CanvasPage | null = null,
): BuiltPage | null {
  const file = version.files.get(path)
  if (!file || !isHtmlPath(path)) return null
  const builder = new PageBuilder(version.files)
  const served = servedHtml(textOf(file.bytes), page, { path, transport: 'port' })
  const taken = takeImportMap(served)
  const body = inline(taken.html, path, builder)

  const embedBinary = version.size <= EMBED_BINARY_BYTES
  const files: Record<string, [string, string]> = {}
  let partial = false
  for (const f of version.files.values()) {
    if (embedBinary || isTextType(f.type))
      files[f.path] = [artifactFileType(f.path), toBase64(f.bytes)]
    else partial = true
  }

  let modules: Record<string, string> | null = null
  const imports: Record<string, string> = {}
  let scopes: Record<string, unknown> | null = null
  if (builder.usesModules || taken.map) {
    modules = {}
    for (const f of version.files.values()) {
      if (/\.m?js$/i.test(f.path)) modules[f.path] = builder.module(f.path)
    }
    // The page's own map: a value naming one of its files would be fetched from nowhere, so it
    // goes to that file's virtual URL, which the prelude maps in turn.
    const own = taken.map
    const values = (entries: unknown): Record<string, string> => {
      const out: Record<string, string> = {}
      if (typeof entries !== 'object' || entries === null) return out
      for (const [key, value] of Object.entries(entries)) {
        if (typeof value !== 'string') continue
        const found = resolveRef(path, value)
        out[key] = found && version.files.has(found.path) ? virtualUrl(found.path) : value
      }
      return out
    }
    Object.assign(imports, values(own?.imports))
    if (own?.scopes && typeof own.scopes === 'object') {
      scopes = {}
      for (const [scope, entries] of Object.entries(own.scopes)) scopes[scope] = values(entries)
    }
  }

  const prelude =
    `<base href="${escapeAttribute(folderUrl(path))}">` +
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(ARTIFACT_CSP)}">` +
    '<meta name="referrer" content="no-referrer">' +
    `<script>${scriptText(
      preludeScript({ files, modules, imports, scopes, origin: VIRTUAL_ORIGIN, page: path }),
    )}</script>`
  // Before the page runtime, which servedHtml put first, so the policy covers everything after.
  const at = /^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i.exec(body)?.[0].length ?? 0
  return { html: body.slice(0, at) + prelude + body.slice(at), partial }
}
