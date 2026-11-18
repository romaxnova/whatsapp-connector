/**
 * Tiny server-rendered HTML: no JavaScript, no external assets, so the pages
 * work under a strict Content-Security-Policy and are easy to audit.
 */
import { DEFAULT_SOURCE_URL } from '../config.js';
import { VERSION } from '../version.js';

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function fmtTime(unix: number | null | undefined): string {
  if (!unix) return '—';
  return new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

const CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#1c1c1e;--muted:#66666d;--card:#ffffff;--border:#d9d9de;--code:#eceef1;--btn:#eef0f3;--btn-border:#8d8d95;--primary:#1a73e8;--on-primary:#fff;--danger:#c0392b;--link:#1558b8;--ok-bg:#e3f4e6;--ok-fg:#1d6b1d;--warn-bg:#fdecc8;--warn-fg:#7a4b00;--alert:#1a73e8;--alert-bg:rgba(26,115,232,.08);--warn-line:#c98a00;--warn-line-bg:rgba(201,138,0,.12);--error-line:#c0392b;--error-line-bg:rgba(192,57,43,.12)}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--fg:#e8e8ea;--muted:#a3a3ab;--card:#1c1c20;--border:#36363c;--code:#2b2b31;--btn:#2b2b31;--btn-border:#5d5d66;--primary:#4c8ff0;--on-primary:#0b1220;--danger:#ef7a6a;--link:#8ab4f8;--ok-bg:#1f3a24;--ok-fg:#9be0a4;--warn-bg:#3d2f10;--warn-fg:#f2c56b;--alert:#4c8ff0;--alert-bg:rgba(76,143,240,.14);--warn-line:#e0a83a;--warn-line-bg:rgba(224,168,58,.14);--error-line:#ef7a6a;--error-line-bg:rgba(239,122,106,.14)}}
*{box-sizing:border-box}
body{font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;padding:24px 16px;max-width:860px;margin-inline:auto;color:var(--fg);background:var(--bg)}
a{color:var(--link)}
h1{font-size:1.5rem;margin:0 0 8px}h2{font-size:1.15rem;margin:28px 0 8px}
.muted{color:var(--muted);font-size:.92rem}
.card{border:1px solid var(--border);border-radius:10px;padding:16px 18px;background:var(--card);margin:14px 0;overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.95rem}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--border);vertical-align:top}
code,pre{background:var(--code);border-radius:4px;padding:2px 5px;font-size:.9em;overflow-wrap:anywhere}
pre{padding:10px;overflow:auto}
.badge{display:inline-block;border-radius:999px;padding:1px 9px;font-size:.8rem;background:var(--ok-bg);color:var(--ok-fg)}
.badge.warn{background:var(--warn-bg);color:var(--warn-fg)}
button,.btn{font:inherit;padding:8px 14px;border-radius:7px;border:1px solid var(--btn-border);background:var(--btn);color:var(--fg);cursor:pointer;text-decoration:none;display:inline-block}
button.primary{background:var(--primary);border-color:var(--primary);color:var(--on-primary);font-weight:600}
button.danger{border-color:var(--danger);color:var(--danger);background:transparent}
form.inline{display:inline}label{display:block;margin:6px 0}
input[type=text],input[type=email],input[type=tel],input[type=password],input[type=time],select{font:inherit;padding:8px 10px;border:1px solid var(--btn-border);border-radius:6px;width:100%;max-width:360px;background:var(--card);color:var(--fg)}
input[type=checkbox],input[type=radio]{accent-color:var(--primary);width:1.05em;height:1.05em;vertical-align:-2px;margin-right:6px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:6px}
.item{padding:12px 0;border-top:1px solid var(--border);display:grid;gap:4px}.item:first-child{border-top:0;padding-top:0}.item:last-child{padding-bottom:0}
.item-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:1.05rem}
.alert{border-left:4px solid var(--alert);padding:8px 12px;background:var(--alert-bg);border-radius:4px}
.alert.warn{border-color:var(--warn-line);background:var(--warn-line-bg)}.alert.error{border-color:var(--error-line);background:var(--error-line-bg)}
nav{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;font-size:.92rem;gap:12px;flex-wrap:wrap}
footer{margin-top:40px;padding-top:12px;border-top:1px solid var(--border)}
.card h2:first-child{margin-top:0}
ol li{margin:6px 0}
.code{font:700 2rem/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;padding:10px 0}
.qr{background:#fff;padding:12px;border-radius:8px;display:inline-block}
`;

function footerFor(sourceUrl: string): string {
  return `<footer class="muted">WhatsApp Connector ${esc(VERSION)} · free software under the GNU AGPL v3 · <a href="${esc(sourceUrl)}">source code</a></footer>`;
}

let footer = footerFor(DEFAULT_SOURCE_URL);

/** Where every page's footer points for the source code (SOURCE_URL): set once when the app is created. */
export function setSourceLink(sourceUrl: string): void {
  footer = footerFor(sourceUrl);
}

export interface PageOptions {
  title: string;
  body: string;
  /** Email of the signed-in owner, shown with a sign-out button. */
  signedInAs?: string;
  /** Reload the page by itself after this many seconds (no script: a meta refresh). */
  refreshSeconds?: number;
}

export function page(opts: PageOptions): string {
  const nav = opts.signedInAs
    ? `<nav><span><a href="/admin">Admin</a></span><span class="muted">${esc(opts.signedInAs)} · <form class="inline" method="post" action="/admin/logout"><button type="submit">Sign out</button></form></span></nav>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light dark">${opts.refreshSeconds ? `<meta http-equiv="refresh" content="${Number(opts.refreshSeconds)}">` : ''}<title>${esc(opts.title)}</title><style>${CSS}</style></head><body>${nav}<h1>${esc(opts.title)}</h1>${opts.body}${footer}</body></html>`;
}
