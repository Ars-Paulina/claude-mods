// Masking engine, ported from ~/.claude/hooks/secret-mask.js (layers b-d copied verbatim).
// Differences from the hook: no Node here, so sha256 comes from crypto.subtle (async) and the
// fingerprint files are read by the caller through $.fs and handed in as `fp`.

export const MAX_SCAN = 2 * 1024 * 1024 // strings over 2 MB are withheld whole, as in the hook
const MIN_EXACT = 8

export type Fingerprints = { byHash: Map<string, string>; lens: Set<number>; maxLen: number }
export type Hit = { label: string }

export const EMPTY_FP: Fingerprints = { byHash: new Map(), lens: new Set(), maxLen: 0 }

async function sha(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Build the exact-value table from the parsed ~/.cache/secret-mask/<APP>.json files. */
export function buildFingerprints(files: unknown[]): Fingerprints {
  const fp: Fingerprints = { byHash: new Map(), lens: new Set(), maxLen: 0 }
  for (const f of files as any[]) {
    for (const r of (f && f.fingerprints) || []) {
      if (typeof r?.sha256 !== 'string' || typeof r?.name !== 'string') continue
      fp.byHash.set(r.sha256, r.name)
      if (r.len) { fp.lens.add(r.len); fp.maxLen = Math.max(fp.maxLen, r.len) }
    }
  }
  return fp
}

// (b) shapes. Order matters: PEM first so its body is masked as one block.
const SHAPES: [string, RegExp][] = [
  ["private_key", /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[A-Za-z0-9+/=\s]{0,16384}-----END [A-Z ]{0,40}PRIVATE KEY-----/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{6,2048}/g],
  ["api_key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g],
  ["telegram_bot", /\b\d{6,12}:[A-Za-z0-9_-]{35}\b/g],
  ["google_oauth_secret", /GOCSPX-[A-Za-z0-9_-]{20,}/g],
  ["supabase_secret_key", /sb_secret_[A-Za-z0-9_-]{16,}/g],
  ["supabase_pat", /sbp_[a-f0-9]{40,}/g],
  ["github_token", /\bgh[posru]_[A-Za-z0-9_]{36,}|\bgithub_pat_[A-Za-z0-9_]{50,}/g],
  ["aws_akid", /\bAKIA[0-9A-Z]{16}\b/g],
  ["slack_token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/g],
  ["npm_token", /\bnpm_[A-Za-z0-9]{36}\b/g],
  ["vercel_token", /\bvc[pk]_[A-Za-z0-9]{24,}/g],
];
// Value-only replacements: group 1 = prefix kept, group 2 = secret.
const BEARER = /(\b(?:Bearer|Basic)\s+)([A-Za-z0-9._~+/-]{16,}=*)/g;
// Password runs to the LAST "@" before the host, so "/", "+" and "@" inside it are covered.
const URL_PW = /((?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"]+:)([^\s'"]{1,256}?)(?=@[^\s@/'"?#]+(?:[:/?#'"\s]|$))/gi;
const QUERY_PW = /([?&;](?:password|passwd|pwd|pass|secret|token|access_token|api_key|apikey|sslpassword)=)([^&#\s'"]+)/gi;
const ENV_KV = /(^|[\s;,{(]|\\n)((?:export\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*([=:])\s*)(["']?)([^\s"'`]+)\5/g;
const JSON_KV = /(\\?"([A-Za-z_][A-Za-z0-9_-]*)\\?"\s*:\s*\\?")((?:[^"\\]|\\[^"])+)(?=\\?")/g;

// Anywhere in the name: ROLE_PASSWORD_ADMIN. Last segment only: JWT_SECRET, GITHUB_TOKEN (not
// secret_scan, token_cost). "key" last only with a hint segment: GEMINI_API_KEY, VAPID_PRIVATE_KEY (not
// cache_key, idempotencyKey). Public/site values are never secret. devrun values are caught exactly anyway.
const ANY_SEGMENTS = new Set(["password", "passwd", "passphrase", "credential", "credentials", "apikey", "privatekey"]);
const LAST_SEGMENTS = new Set(["secret", "token", "pass", "pwd"]);
const KEY_HINTS = new Set(["api", "secret", "private", "access", "auth", "service", "role", "encryption",
  "signing", "hmac", "master", "license", "client", "admin"]);
const NEVER_SEGMENTS = new Set(["public", "publishable", "site", "anon", // public values
  "input", "schema", "type", "form", "field", "label", "err", "error", "invalid", "forgot", "hint", // code names
  "policy", "strength", "length", "vars", "gate", "title", "pre", "base"]);

function isSecretName(name: string): boolean {
  const segs = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[_.-]+/).filter(Boolean);
  if (!segs.length || segs.some((s) => NEVER_SEGMENTS.has(s))) return false;
  const last = segs[segs.length - 1]!;
  if (segs.some((s) => ANY_SEGMENTS.has(s)) || LAST_SEGMENTS.has(last)) return true;
  return last === "key" && segs.slice(0, -1).some((s) => KEY_HINTS.has(s));
}

const PLACEHOLDER = /^(\*+|x{3,}|\.{3}|<[^>]*>|\$\{?[A-Za-z_][\w]*\}?|\[MASKED[^\]]*\]?|true|false|null|none|undefined|changeme|redacted|string|number)$/i;

// A context value must look like a literal secret, not code (z.string(), process.env.X, getToken()),
// prose ("pass: skipped"), an env var name, or a date.
function looksLikeSecretValue(v: string, name: string): boolean {
  v = v.replace(/[.,;:]+$/, "");
  if (v.length < 6 || PLACEHOLDER.test(v) || v.startsWith("[MASKED")) return false;
  if (/[()[\]]/.test(v) || v.startsWith("/") || v.startsWith("~")) return false;
  if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(v)) return false; // a.b.c identifier chain
  if (/^[A-Z][A-Z0-9_,]*$/.test(v) || /^\d{4}-\d{2}-\d{2}/.test(v)) return false; // ENV_NAME, date
  if (/^[A-Za-z]+$/.test(v) && v.length < 20) return false; // bare word: Password, string, skipped
  if (/^\d+$/.test(v) && v.length < 8) return false; // counts, ports
  // Bare one-word names ("key", "pass", "secret") are mostly prose or {key, value} pairs.
  if (WEAK_NAMES.has(name.toLowerCase())) return v.length >= 12 && /[A-Za-z]/.test(v) && /\d/.test(v);
  return true;
}
const WEAK_NAMES = new Set(["key", "pass", "secret", "token", "pwd"]);


const TRAIL = /[.,;:)\]}>]{1,64}$/;
// Candidate substrings for the exact layer. ponytail: a value glued mid-token with no delimiter is
// missed; layers (b)-(d) backstop it.
function* candidates(s: string, FP_MAXLEN: number): Generator<string> {
  for (const tok of s.split(/[\s"'`]+/)) {
    if (tok.length < MIN_EXACT || tok.length > 4 * FP_MAXLEN + 64) continue;
    yield tok;
    const t = tok.replace(TRAIL, "");
    if (t !== tok) yield t;
    const eq = tok.indexOf("=");
    if (eq >= 0) { yield tok.slice(eq + 1); yield tok.slice(eq + 1).replace(TRAIL, ""); }
    for (const part of tok.split(/[=,;()<>[\]{}|]+/)) if (part !== tok) { yield part; yield part.replace(TRAIL, ""); }
  }
}

/** Mask one string. Same layers and order as the hook's maskString. */
export async function maskString(s: string, fp: Fingerprints = EMPTY_FP): Promise<{ text: string; hits: Hit[] }> {
  const hits: Hit[] = []
  if (typeof s !== 'string' || s.length < 6) return { text: s, hits }
  if (s.length > MAX_SCAN) {
    hits.push({ label: 'oversize' })
    return { text: `[MASKED: ${s.length} bytes, too large to scan for secrets]`, hits }
  }
  const hit = (label: string, _v: string) => { hits.push({ label }); return `[MASKED:${label}]` }
  let out = s

  // (a) exact values. Only candidates whose length matches a stored value get hashed.
  if (fp.byHash.size) {
    const want = new Set<string>()
    for (const c of candidates(out, fp.maxLen)) {
      if (c.length < MIN_EXACT || (fp.maxLen && c.length > fp.maxLen)) continue
      if (fp.lens.size && !fp.lens.has(c.length)) continue
      want.add(c)
    }
    const found: [string, string][] = []
    for (const c of want) { const name = fp.byHash.get(await sha(c)); if (name) found.push([c, name]) }
    // Longest first so a value containing another is replaced whole.
    for (const [v, name] of found.sort((x, y) => y[0].length - x[0].length)) {
      if (out.includes(v)) { out = out.split(v).join(`[MASKED:${name}]`); hits.push({ label: name }) }
    }
  }
  // (b) shapes
  for (const [label, re] of SHAPES) out = out.replace(re, (m: string) => hit(label, m));
  // (d) URL password, bearer
  out = out.replace(URL_PW, (m: string, pre: string, pw: string) => (pw.startsWith("[MASKED") || PLACEHOLDER.test(pw) || /^(password|pass|pwd|pw|secret)$/i.test(pw) || pw.length < 4 ? m : pre + hit("url_password", pw)));
  out = out.replace(QUERY_PW, (m: string, pre: string, v: string) => (v.startsWith("[MASKED") || PLACEHOLDER.test(v) || v.length < 4 ? m : pre + hit("query_password", v)));
  out = out.replace(BEARER, (m: string, pre: string, tok: string) => (tok.startsWith("[MASKED") ? m : pre + hit("bearer", tok)));
  // (c) key-name context
  out = out.replace(JSON_KV, (m: string, pre: string, name: string, v: string) =>
    isSecretName(name) && looksLikeSecretValue(v, name) ? pre + hit(name, v) : m);
  out = out.replace(ENV_KV, (m: string, lead: string, pre: string, name: string, sep: string, q: string, v: string) =>
    // one-word names ("pass:", "key:") with ":" are prose or YAML labels far more often than secrets
    isSecretName(name) && looksLikeSecretValue(v, name) && !(sep === ":" && WEAK_NAMES.has(name.toLowerCase()))
      ? lead + pre + q + hit(name, v) + q : m);


  return { text: out, hits }
}
