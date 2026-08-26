import { normalizeUrl } from "./db.js";
import { CustomSourceSchema } from "./config.js";
import type { CustomHtmlField, CustomJobSource, CustomSourceParser } from "../shared.js";

export const CUSTOM_SOURCE_TIMEOUT_MS = 10_000;
export const CUSTOM_SOURCE_MAX_RESPONSE_BYTES = 1_000_000;
export const CUSTOM_SOURCE_MAX_RESULTS = 5;

export type CustomSourceFetch = (input: string, init?: RequestInit) => Promise<Response>;

type NormalizedSearchJob = { id: string; title: string; company: string; location: string; url: string };
type NormalizedDetail = { id: string; title: string; url: string; description: string };

function textValue(value: unknown, label: string, max = 30_000): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new Error(`${label} must resolve to text.`);
  const text = String(value).trim();
  if (text.length > max) throw new Error(`${label} is too long.`);
  return text;
}

function pathParts(path: string): Array<string | number> {
  const value = path.replace(/^\$\./, "");
  const parts: Array<string | number> = [];
  const matcher = /(?:^|\.)([A-Za-z_][A-Za-z0-9_-]*)|\[(\d+)\]/g;
  let consumed = 0;
  for (const match of value.matchAll(matcher)) {
    if (match.index !== consumed && !(match.index === 0 && value.startsWith("["))) throw new Error("Invalid JSON field path.");
    consumed = match.index + match[0].length;
    parts.push(match[1] ?? Number(match[2]));
  }
  if (!parts.length || consumed !== value.length) throw new Error("Invalid JSON field path.");
  return parts;
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of pathParts(path)) {
    if (current === null || current === undefined || (typeof part === "string" && !Object.prototype.hasOwnProperty.call(current, part))) return undefined;
    if (typeof part === "number" && !Array.isArray(current)) return undefined;
    current = (current as Record<string | number, unknown>)[part];
  }
  return current;
}

function safeUrl(value: unknown, base: URL, label: string): string {
  const raw = textValue(value, label, 2_000);
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) throw new Error(`${label} must be a safe HTTP(S) URL.`);
  let url: URL;
  try { url = new URL(raw, base); } catch { throw new Error(`${label} must be a safe HTTP(S) URL.`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${label} must use HTTP or HTTPS.`);
  if (url.username || url.password) throw new Error(`${label} must not contain URL credentials.`);
  return normalizeUrl(url.toString());
}

function interpolate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{\{(query|location|limit|id|url)\}\}/g, (_match, key: string) => encodeURIComponent(String(values[key] ?? "")));
}

function templateBase(template: string): URL {
  return new URL(template.replace(/\{\{[^{}]+\}\}/g, "placeholder"));
}

async function readResponse(response: Response, maxBytes: number): Promise<string> {
  if (!response.ok) throw new Error(`Custom source returned HTTP ${response.status}.`);
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) throw new Error("Custom source response is too large.");
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("Custom source response is too large.");
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("Custom source response is too large.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

async function requestText(fetcher: CustomSourceFetch, url: string, signal: AbortSignal | undefined, timeoutMs: number, maxBytes: number): Promise<string> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  const timer = setTimeout(() => controller.abort(new Error("Custom source request timed out.")), timeoutMs);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await readResponse(await fetcher(url, { signal: controller.signal, redirect: "error" }), maxBytes);
  } catch (error) {
    if (controller.signal.aborted && signal?.aborted) throw error;
    if (controller.signal.aborted) throw new Error("Custom source request timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

type HtmlNode = { tag: string; attrs: Record<string, string>; children: HtmlNode[]; text: string; parent?: HtmlNode };

function parseHtml(value: string): HtmlNode {
  const root: HtmlNode = { tag: "#root", attrs: {}, children: [], text: "" };
  const stack: HtmlNode[] = [root];
  const tokenPattern = /<!--[\s\S]*?-->|<[^>]*>|[^<]+/g;
  let nodeCount = 0;
  for (const token of value.matchAll(tokenPattern)) {
    const part = token[0];
    if (part.startsWith("<!--") || /^<!/.test(part)) continue;
    if (part.startsWith("</")) {
      const tag = part.match(/^<\/\s*([A-Za-z][A-Za-z0-9:-]*)/)?.[1]?.toLowerCase();
      if (tag) {
        while (stack.length > 1 && stack[stack.length - 1].tag !== tag) stack.pop();
        if (stack.length > 1) stack.pop();
      }
      continue;
    }
    if (!part.startsWith("<")) {
      stack[stack.length - 1].text += part;
      continue;
    }
    const tagText = part.match(/^<\s*([A-Za-z][A-Za-z0-9:-]*)/)?.[1];
    if (!tagText) continue;
    const tag = tagText.toLowerCase();
    nodeCount++;
    if (nodeCount > 10_000) throw new Error("Custom source HTML contains too many elements.");
    const attrs: Record<string, string> = {};
    const attributeText = part.slice((part.indexOf(tagText) + tagText.length), part.endsWith(">") ? -1 : undefined);
    const attributePattern = /([A-Za-z_:][A-Za-z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    for (const match of attributeText.matchAll(attributePattern)) attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
    const node: HtmlNode = { tag, attrs, children: [], text: "", parent: stack[stack.length - 1] };
    stack[stack.length - 1].children.push(node);
    if (!/^area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr$/.test(tag) && !/\/\s*>$/.test(part)) stack.push(node);
  }
  return root;
}

type SelectorToken = { tag?: string; id?: string; classes: string[]; attribute?: { name: string; value?: string } };

function selectorToken(value: string): SelectorToken {
  const match = value.match(/^(\*|[A-Za-z][A-Za-z0-9_-]*)?(#[A-Za-z][A-Za-z0-9_-]*)?((?:\.[A-Za-z][A-Za-z0-9_-]*)*)(?:\[([A-Za-z_:][A-Za-z0-9_.:-]*)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\])?$/);
  if (!match || (!match[1] && !match[2] && !match[3] && !match[4])) throw new Error("Custom source selector is outside the supported subset.");
  return {
    tag: match[1] && match[1] !== "*" ? match[1].toLowerCase() : undefined,
    id: match[2]?.slice(1),
    classes: match[3] ? match[3].split(".").filter(Boolean) : [],
    attribute: match[4] ? { name: match[4].toLowerCase(), value: (match[5] ?? match[6] ?? match[7])?.trim() } : undefined,
  };
}

function selectorParts(selector: string): { tokens: SelectorToken[]; direct: boolean[] } {
  const pieces = selector.trim().replace(/>/g, " > ").split(/\s+/).filter(Boolean);
  const tokens: SelectorToken[] = [];
  const direct: boolean[] = [];
  let relation: "descendant" | "direct" = "descendant";
  for (const piece of pieces) {
    if (piece === ">") { relation = "direct"; continue; }
    if (tokens.length) direct.push(relation === "direct");
    tokens.push(selectorToken(piece));
    relation = "descendant";
  }
  return { tokens, direct };
}

function matchesToken(node: HtmlNode, token: SelectorToken): boolean {
  if (node.tag === "#root" || (token.tag && node.tag !== token.tag)) return false;
  if (token.id && node.attrs.id !== token.id) return false;
  const classes = (node.attrs.class ?? "").split(/\s+/).filter(Boolean);
  if (token.classes.some((value) => !classes.includes(value))) return false;
  if (token.attribute && !(token.attribute.name in node.attrs)) return false;
  if (token.attribute?.value !== undefined && node.attrs[token.attribute.name] !== token.attribute.value) return false;
  return true;
}

function matchesSelector(node: HtmlNode, selector: ReturnType<typeof selectorParts>): boolean {
  if (!selector.tokens.length || !matchesToken(node, selector.tokens[selector.tokens.length - 1])) return false;
  let current: HtmlNode | undefined = node;
  for (let index = selector.tokens.length - 2; index >= 0; index--) {
    if (selector.direct[index]) {
      current = current?.parent;
      if (!current || !matchesToken(current, selector.tokens[index])) return false;
      continue;
    }
    current = current?.parent;
    while (current && !matchesToken(current, selector.tokens[index])) current = current.parent;
    if (!current) return false;
  }
  return true;
}

function findNodes(root: HtmlNode, selector: string): HtmlNode[] {
  const parsed = selectorParts(selector);
  const result: HtmlNode[] = [];
  const visit = (node: HtmlNode) => {
    if (matchesSelector(node, parsed)) result.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return result;
}

function htmlText(node: HtmlNode): string {
  return `${node.text} ${node.children.map(htmlText).join(" ")}`.replace(/\s+/g, " ").trim();
}

function readHtmlField(root: HtmlNode, field: CustomHtmlField, label: string): string {
  const node = findNodes(root, field.selector)[0];
  if (!node) return "";
  const value = field.attribute ? node.attrs[field.attribute.toLowerCase()] : htmlText(node);
  return textValue(value, label);
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { throw new Error("Custom source returned invalid JSON."); }
}

function parseSearch(parser: CustomSourceParser, body: string, base: URL, limit: number): NormalizedSearchJob[] {
  if (parser.format === "json") {
    const payload = parseJson(body);
    const rows = readPath(payload, parser.search.resultsPath);
    if (!Array.isArray(rows)) throw new Error("Custom JSON search results path must resolve to an array.");
    return rows.slice(0, Math.min(limit, CUSTOM_SOURCE_MAX_RESULTS)).map((row, index) => {
      const id = textValue(readPath(row, parser.search.fields.id), `Custom search result ${index + 1} ID`, 200);
      const title = textValue(readPath(row, parser.search.fields.title), `Custom search result ${index + 1} title`, 500);
      const url = safeUrl(readPath(row, parser.search.fields.url), base, `Custom search result ${index + 1} URL`);
      if (!id || !title) throw new Error(`Custom search result ${index + 1} is missing an ID or title.`);
      return { id, title, company: textValue(parser.search.fields.company ? readPath(row, parser.search.fields.company) : "", "Custom company", 500), location: textValue(parser.search.fields.location ? readPath(row, parser.search.fields.location) : "", "Custom location", 500), url };
    });
  }
  const root = parseHtml(body);
  return findNodes(root, parser.search.itemSelector).slice(0, Math.min(limit, CUSTOM_SOURCE_MAX_RESULTS)).map((row, index) => {
    const id = readHtmlField(row, parser.search.fields.id, `Custom search result ${index + 1} ID`);
    const title = readHtmlField(row, parser.search.fields.title, `Custom search result ${index + 1} title`);
    const url = safeUrl(readHtmlField(row, parser.search.fields.url, `Custom search result ${index + 1} URL`), base, `Custom search result ${index + 1} URL`);
    if (!id || !title) throw new Error(`Custom search result ${index + 1} is missing an ID or title.`);
    return { id, title, company: parser.search.fields.company ? readHtmlField(row, parser.search.fields.company, "Custom company") : "", location: parser.search.fields.location ? readHtmlField(row, parser.search.fields.location, "Custom location") : "", url };
  });
}

function parseDetail(parser: CustomSourceParser, body: string, base: URL): NormalizedDetail {
  if (parser.format === "json") {
    const payload = parseJson(body);
    return { id: textValue(readPath(payload, parser.detail.fields.id), "Custom detail ID", 200), title: textValue(readPath(payload, parser.detail.fields.title), "Custom detail title", 500), url: safeUrl(readPath(payload, parser.detail.fields.url), base, "Custom detail URL"), description: textValue(readPath(payload, parser.detail.fields.description), "Custom detail description") };
  }
  const root = parseHtml(body);
  return { id: readHtmlField(root, parser.detail.fields.id, "Custom detail ID"), title: readHtmlField(root, parser.detail.fields.title, "Custom detail title"), url: safeUrl(readHtmlField(root, parser.detail.fields.url, "Custom detail URL"), base, "Custom detail URL"), description: readHtmlField(root, parser.detail.fields.description, "Custom detail description") };
}

export function validateCustomSourceDefinition(value: unknown): CustomJobSource {
  return CustomSourceSchema.parse(value) as CustomJobSource;
}

export function createCustomSourceAdapter(sourceValue: CustomJobSource, options: { fetcher?: CustomSourceFetch; timeoutMs?: number; maxBytes?: number } = {}) {
  const source = validateCustomSourceDefinition(sourceValue);
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? CUSTOM_SOURCE_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? CUSTOM_SOURCE_MAX_RESPONSE_BYTES;
  const searchBase = templateBase(source.searchUrlTemplate);
  const detailBase = templateBase(source.detailUrlTemplate);

  return {
    async search(query: string, location: string, limit: number, signal?: AbortSignal) {
      const url = interpolate(source.searchUrlTemplate, { query, location, limit });
      const body = await requestText(fetcher, url, signal, timeoutMs, maxBytes);
      const results = parseSearch(source.parser, body, searchBase, limit);
      return { meta: { count: results.length }, results };
    },
    async detail(sourceId: string, expectedUrl: string, signal?: AbortSignal) {
      const url = interpolate(source.detailUrlTemplate, { id: sourceId, url: expectedUrl });
      const body = await requestText(fetcher, url, signal, timeoutMs, maxBytes);
      const detail = parseDetail(source.parser, body, detailBase);
      if (detail.id !== sourceId || normalizeUrl(detail.url) !== normalizeUrl(expectedUrl)) throw new Error(`${source.label} detail provenance mismatch`);
      return detail;
    },
  };
}
