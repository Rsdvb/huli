// The viewer's own page in the web view, which holds an artifact's page in a sandboxed frame, as
// the web client's window does (src/renderer/src/features/artifacts/page-frame.tsx): the frame gets
// `allow-scripts allow-forms` only, so the page runs on an opaque origin and can reach neither this
// shell nor the app. The shell hands the page runtime its port, passes the page's messages to the
// app with a nonce the page never sees, and posts the app's messages into the frame.

import { RUNTIME_MESSAGE_BYTES } from '@shared/artifact-capabilities'
import { WEB_ARTIFACT_FRAME_SANDBOX } from '@shared/artifacts'

/** How the page lays out: filling the view as a site does, or at a canvas page's own size. */
export type FrameLayout = { kind: 'fluid' } | { kind: 'fixed'; width: number; height: number }

function json(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

// Downloads mean nothing in the phone's web view, so the frame gets the web client's sandbox less
// them; the page may never open windows, navigate this shell or show modal dialogs.
const SANDBOX = WEB_ARTIFACT_FRAME_SANDBOX.split(' ')
  .filter((token) => token !== 'allow-downloads')
  .join(' ')

export function shellHtml(options: {
  page: string
  layout: FrameLayout
  nonce: string
  background: string
}): string {
  const fixed = options.layout.kind === 'fixed'
  const size = options.layout.kind === 'fixed' ? options.layout : { width: 0, height: 0 }
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,minimum-scale=1,maximum-scale=5,viewport-fit=cover">
<style>
html,body{margin:0;padding:0;background:${options.background};-webkit-text-size-adjust:100%}
body.fluid{height:100%;overflow:hidden}
#stage{position:relative;overflow:hidden}
body.fluid #stage{position:fixed;inset:0}
iframe{border:0;display:block;background:#fff}
body.fluid iframe{width:100%;height:100%}
body.fixed iframe{transform-origin:0 0;position:absolute;left:0;top:0}
#pick{position:absolute;inset:0;display:none;background:rgba(0,0,0,0.04)}
body.picking #pick{display:block}
</style></head>
<body class="${fixed ? 'fixed' : 'fluid'}"><div id="stage"><iframe id="frame" sandbox="${SANDBOX}" allow="" referrerpolicy="no-referrer" title="Artifact"></iframe><div id="pick"></div></div>
<script>(()=>{
const NONCE=${json(options.nonce)},PAGE=${json(options.page)},FIXED=${fixed},W=${size.width},H=${size.height},LIMIT=${RUNTIME_MESSAGE_BYTES};
const bridge=window.ReactNativeWebView;
const send=(m)=>{m.n=NONCE;try{bridge.postMessage(JSON.stringify(m))}catch(e){}};
const frame=document.getElementById('frame'),stage=document.getElementById('stage'),pick=document.getElementById('pick');
let port=null,scale=1;
const layout=()=>{if(!FIXED)return;scale=document.documentElement.clientWidth/W;frame.style.width=W+'px';frame.style.height=H+'px';frame.style.transform='scale('+scale+')';stage.style.width=(W*scale)+'px';stage.style.height=(H*scale)+'px'};
frame.addEventListener('load',()=>{
if(port){port.onmessage=null;port.close()}
const channel=new MessageChannel();port=channel.port1;
port.onmessage=(e)=>{let text;try{text=JSON.stringify(e.data)}catch(x){return}if(typeof text!=='string'||text.length>LIMIT)return;send({kind:'page',text})};
frame.contentWindow.postMessage({v:1,kind:'transport'},'*',[channel.port2]);
send({kind:'loaded'})});
addEventListener('message',(e)=>{
if(e.source!==frame.contentWindow)return;const d=e.data;if(!d||typeof d!=='object')return;
if(d.__huli==='link'&&typeof d.href==='string'&&d.href.length<=4096)send({kind:'link',href:d.href});
else if(d.__huli==='open'&&typeof d.path==='string'&&d.path.length<=1024&&typeof d.hash==='string'&&d.hash.length<=1024)send({kind:'open',path:d.path,hash:d.hash})});
pick.addEventListener('click',(e)=>{const r=frame.getBoundingClientRect();const s=FIXED?scale:1;
if(frame.contentWindow)frame.contentWindow.postMessage({v:1,kind:'select-pick',x:(e.clientX-r.left)/s,y:(e.clientY-r.top)/s},'*')});
window.__huli=Object.freeze({
drive(m){if(frame.contentWindow)frame.contentWindow.postMessage(m,'*')},
answer(a){if(port)port.postMessage(a)},
picking(on){document.body.classList.toggle('picking',!!on)}});
layout();addEventListener('resize',layout);
frame.srcdoc=PAGE;
send({kind:'shell'})})()</script></body></html>`
}

/** A script that calls the shell, for the web view's injectJavaScript. */
export function shellCall(method: 'drive' | 'answer' | 'picking', value: unknown): string {
  return `window.__huli&&window.__huli.${method}(${json(value)});true;`
}
