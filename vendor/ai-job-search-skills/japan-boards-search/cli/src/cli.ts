#!/usr/bin/env bun

type Source = "tokyodev" | "japan-dev" | "relocate-me"

export interface JobRecord {
  id: string
  source: Source
  title: string
  company: string | null
  location: string | null
  postedDate: string | null
  url: string
  applicationUrl: string | null
  visaSignal: string
  languageSignal: string
  workMode: string | null
  skills: string[]
  summary: string | null
}

interface Flags {
  _: string[]
  [key: string]: string | boolean | string[]
}

const SOURCE_URLS: Record<Source, string> = {
  tokyodev: "https://www.tokyodev.com/jobs",
  "japan-dev": "https://japan-dev.com/jobs",
  "relocate-me": "https://relocate.me/international-jobs",
}

const USER_AGENT = "ai-job-search personal research client/1.0"
const JAPAN_DEV_MAX_RESPONSE_BYTES = 2_000_000
const JAPAN_DEV_MAX_RESULTS = 100
const JAPAN_DEV_MAX_RESOLUTIONS = 200_000

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { _: [] }
  const aliases: Record<string, string> = { q: "query", n: "limit" }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith("--")) {
      const key = aliases[arg.slice(2)] ?? arg.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("-")) flags[key] = true
      else {
        flags[key] = next
        i++
      }
    } else (flags._ as string[]).push(arg)
  }
  return flags
}

function cleanHtml(value: string): string {
  return decodeEntities(value.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
}

function titleCaseSlug(value: string): string {
  return value.split("-").filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ")
}

async function fetchText(url: string, init?: RequestInit, maxBytes?: number): Promise<string> {
  const response = await fetch(url, {
    ...init,
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/json", ...(init?.headers ?? {}) },
  })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} from ${url}`)
  if (maxBytes === undefined || !response.body) {
    const text = await response.text()
    if (maxBytes !== undefined && new TextEncoder().encode(text).byteLength > maxBytes) throw new Error(`response from ${url} exceeds ${maxBytes} bytes`)
    return text
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new Error(`response from ${url} exceeds ${maxBytes} bytes`)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function hasAny(text: string, terms: string[]): boolean {
  const lower = text.toLowerCase()
  return terms.some((term) => lower.includes(term))
}

function extractTags(text: string): string[] {
  return [...text.matchAll(/href="\/jobs\/([a-z0-9-]+)"/gi)].map((m) => titleCaseSlug(m[1]))
}

function parseTokyoDev(html: string): JobRecord[] {
  const jobs: JobRecord[] = []
  const pattern = /<a[^>]+href="(\/companies\/([^/"#]+)\/jobs\/([^"#]+))"[^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    const href = match[1]
    const block = html.slice(match.index, match.index + 1800)
    const tags = extractTags(block)
    jobs.push({
      id: `tokyodev:${match[3]}`,
      source: "tokyodev",
      title: cleanHtml(match[4]),
      company: titleCaseSlug(match[2]),
      location: "Japan",
      postedDate: null,
      url: `https://www.tokyodev.com${href}`,
      applicationUrl: null,
      visaSignal: hasAny(block, ["apply-from-abroad", "no-japanese-required"]) ? "overseas/no-Japanese signal" : "unknown",
      languageSignal: hasAny(block, ["no-japanese-required"]) ? "Japanese not required" : hasAny(block, ["japanese-required"]) ? "Japanese required" : "unknown",
      workMode: hasAny(block, ["fully-remote"]) ? "remote" : hasAny(block, ["partially-remote"]) ? "hybrid" : null,
      skills: tags.filter((tag) => !["Apply From Abroad", "No Japanese Required", "Japanese Required", "Residents Only", "Partially Remote", "Fully Remote", "No Remote"].includes(tag)),
      summary: null,
    })
  }
  return jobs
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function textValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return null
}

function textValues(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.flatMap((item) => {
    if (typeof item === "string") {
      const text = textValue(item)
      return text ? [text] : []
    }
    if (isRecord(item)) {
      const text = textValue(item.name)
      return text ? [text] : []
    }
    return []
  }))]
}

function extractNuxtData(html: string): string {
  const match = /<script\b(?=[^>]*\bid\s*=\s*["']__NUXT_DATA__["'])[^>]*>([\s\S]*?)<\/script\s*>/i.exec(html)
  if (!match) throw new Error("Japan Dev page is missing __NUXT_DATA__ payload")
  const payload = match[1].trim()
  if (!payload) throw new Error("Japan Dev __NUXT_DATA__ payload is empty")
  return payload
}

export function parseJapanDevPayload(html: string, maxResults = JAPAN_DEV_MAX_RESULTS): JobRecord[] {
  const json = extractNuxtData(html)
  let payload: unknown
  try {
    payload = JSON.parse(json)
  } catch {
    throw new Error("Japan Dev __NUXT_DATA__ payload is malformed JSON")
  }
  if (!Array.isArray(payload)) throw new Error("Japan Dev __NUXT_DATA__ payload must be an array")
  const values = payload
  const requestedLimit = Number.isFinite(maxResults) ? Math.floor(maxResults) : JAPAN_DEV_MAX_RESULTS
  const resultLimit = Math.min(JAPAN_DEV_MAX_RESULTS, Math.max(1, requestedLimit))
  const resolved = new Map<number, unknown>()
  const resolving = new Set<number>()
  let resolutionCount = 0

  function resolveValue(value: unknown): unknown {
    return typeof value === "number" && Number.isInteger(value) ? resolveReference(value) : value
  }

  function resolveReference(index: number): unknown {
    if (index < 0) return undefined
    if (index >= values.length) throw new Error(`Japan Dev __NUXT_DATA__ reference ${index} is out of range`)
    const cached = resolved.get(index)
    if (cached !== undefined || resolved.has(index)) return cached
    if (resolving.has(index)) throw new Error("Japan Dev __NUXT_DATA__ payload has a cyclic reference")
    if (++resolutionCount > JAPAN_DEV_MAX_RESOLUTIONS) throw new Error("Japan Dev __NUXT_DATA__ payload has too many references")
    resolving.add(index)
    try {
      const raw = values[index]
      let value: unknown
      if (Array.isArray(raw)) {
        if (raw[0] === "Date" && raw.length === 2) value = resolveValue(raw[1])
        else if ((raw[0] === "ShallowReactive" || raw[0] === "Reactive") && raw.length === 2) value = resolveValue(raw[1])
        else value = raw.map(resolveValue)
      } else if (isRecord(raw)) {
        const object = Object.create(null) as Record<string, unknown>
        for (const [key, item] of Object.entries(raw)) object[key] = resolveValue(item)
        value = object
      } else value = raw
      resolved.set(index, value)
      return value
    } finally {
      resolving.delete(index)
    }
  }

  const jobs: JobRecord[] = []
  const seen = new Set<string>()
  for (let index = 0; index < values.length && jobs.length < resultLimit; index++) {
    const value = resolveReference(index)
    if (!isRecord(value)) continue
    const title = textValue(value.title)
    const slug = textValue(value.slug)
    const date = textValue(value.job_post_date)
    const location = textValue(value.location)
    const companyObject = isRecord(value.company) ? value.company : undefined
    const company = textValue(value.company_name) ?? textValue(companyObject?.name)
    const companySlug = textValue(value.company_slug) ?? textValue(companyObject?.slug)
    if (!title || !slug || !date || !location || !company || !companySlug) continue

    const objectId = textValue(value.objectID) ?? textValue(value.id) ?? slug
    const url = `${SOURCE_URLS["japan-dev"]}/${encodeURIComponent(companySlug)}/${encodeURIComponent(slug)}`
    const slugKey = slug.toLowerCase()
    const keys = [`id:${objectId}`, `slug:${slugKey}`, `url:${url}`]
    if (keys.some((key) => seen.has(key))) continue
    keys.forEach((key) => seen.add(key))

    const skills = textValues(value.skill_names)
    const fallbackSkills = skills.length ? skills : textValues(value.skills)
    const tags = [...textValues(value.company_tag_names), ...fallbackSkills]
    const visa = textValue(value.sponsors_visas) === "sponsors_visas_yes" || tags.some((tag) => /sponsor|visa/i.test(tag))
      ? "visa sponsorship signal"
      : "unknown"
    const languageSignal = textValue(value.japanese_level) ?? textValue(value.english_level) ?? "unknown"
    const workMode = textValue(value.remote_level)?.replace(/^remote_level_/i, "") ?? null
    const summarySource = [value.intro, value.details, value.company_description, companyObject?.short_description]
      .map(textValue)
      .find((text): text is string => Boolean(text))
    jobs.push({
      id: `japan-dev:${objectId}`,
      source: "japan-dev",
      title,
      company,
      location,
      postedDate: date,
      url,
      applicationUrl: textValue(value.application_url),
      visaSignal: visa,
      languageSignal,
      workMode,
      skills: fallbackSkills,
      summary: summarySource ? cleanHtml(summarySource) || null : null,
    })
  }
  return jobs
}

function parseRelocate(html: string): JobRecord[] {
  const jobs: JobRecord[] = []
  const blocks = html.split('<div class="jobs-list__job">').slice(1)
  for (const [index, block] of blocks.entries()) {
    const link = block.match(/<a href="([^"]+)">\s*<b>([\s\S]*?)<\/b>/i)
    if (!link) continue
    const places = [...block.matchAll(/<div class="job__company[^>]*>[\s\S]*?<p>([^<]+)<\/p>/gi)].map((m) => cleanHtml(m[1]))
    const preview = cleanHtml(block.match(/<p class="job__preview">([\s\S]*?)<\/p>/i)?.[1] ?? "")
    const sourceText = `${places.join(" ")} ${link[2]} ${preview}`
    jobs.push({
      id: `relocate-me:${link[1]}`,
      source: "relocate-me",
      title: cleanHtml(link[2]),
      company: places[1] ?? null,
      location: places[0] ?? null,
      postedDate: null,
      url: `https://relocate.me${link[1]}`,
      applicationUrl: null,
      visaSignal: hasAny(sourceText, ["visa", "sponsorship", "relocation", "apply from abroad"]) ? "relocation/visa signal" : "relocation-focused source, verify",
      languageSignal: "English-friendly source, verify posting",
      workMode: hasAny(sourceText, ["remote"]) ? "remote/unknown" : null,
      skills: [],
      summary: preview || null,
    })
    if (index > 500) break
  }
  return jobs
}

async function parseJapanDev(): Promise<JobRecord[]> {
  const html = await fetchText(SOURCE_URLS["japan-dev"], undefined, JAPAN_DEV_MAX_RESPONSE_BYTES)
  return parseJapanDevPayload(html)
}

async function searchSource(source: Source, query: string, limit: number): Promise<JobRecord[]> {
  if (source === "japan-dev") return parseJapanDev()
  const html = await fetchText(SOURCE_URLS[source])
  return source === "tokyodev" ? parseTokyoDev(html) : parseRelocate(html)
}

function matchesQuery(job: JobRecord, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  const haystack = [job.title, job.company, job.location, job.summary, ...job.skills].join(" ").toLowerCase()
  return tokens.every((token) => haystack.includes(token))
}

function matchesCountry(job: JobRecord, country: string): boolean {
  return country.toLowerCase() === "japan" ? hasAny([job.location, job.summary].join(" "), ["japan", "tokyo", "osaka", "kyoto", "fukuoka", "nagoya"]) : true
}

function matchesVisa(job: JobRecord): boolean {
  return job.visaSignal !== "unknown" || job.languageSignal.toLowerCase().includes("not required")
}

function isRecent(postedDate: string | null, days: number, now = Date.now()): boolean {
  if (!postedDate) return true
  const timestamp = Date.parse(postedDate)
  if (Number.isNaN(timestamp)) return true
  return now - timestamp <= days * 24 * 60 * 60 * 1000
}

export interface JobFilterOptions {
  query: string
  country?: string
  visa?: boolean
  jobage?: number
  now?: number
}

export function filterJobs(jobs: JobRecord[], options: JobFilterOptions): JobRecord[] {
  return jobs
    .filter((job) => matchesQuery(job, options.query))
    .filter((job) => options.country === undefined || matchesCountry(job, options.country))
    .filter((job) => !options.visa || matchesVisa(job))
    .filter((job) => options.jobage === undefined || isRecent(job.postedDate, options.jobage, options.now))
    .filter((job, index, all) => all.findIndex((other) => other.url === job.url || `${other.company}|${other.title}`.toLowerCase() === `${job.company}|${job.title}`.toLowerCase()) === index)
}

function interleaveBySource(jobs: JobRecord[], limit: number): JobRecord[] {
  const groups = new Map<Source, JobRecord[]>()
  for (const job of jobs) groups.set(job.source, [...(groups.get(job.source) ?? []), job])
  const results: JobRecord[] = []
  while (results.length < limit && groups.size) {
    for (const [source, group] of groups) {
      const next = group.shift()
      if (next) results.push(next)
      if (!group.length) groups.delete(source)
      if (results.length >= limit) break
    }
  }
  return results
}

function writeError(error: string, code: string): number {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
  return 1
}

function output(jobs: JobRecord[], format: string): void {
  if (format === "json") {
    process.stdout.write(JSON.stringify({ count: jobs.length, results: jobs }, null, 2) + "\n")
    return
  }
  if (format === "plain") {
    for (const job of jobs) process.stdout.write(`${job.title}\n${job.company ?? ""} | ${job.location ?? ""}\n${job.visaSignal} | ${job.url}\n\n`)
    return
  }
  process.stdout.write("#  SOURCE       TITLE                                      COMPANY                 LOCATION\n")
  process.stdout.write("-  -----------  -----------------------------------------  ---------------------  --------------------\n")
  jobs.forEach((job, index) => process.stdout.write(`${String(index + 1).padStart(2)} ${job.source.padEnd(11)}  ${job.title.slice(0, 41).padEnd(41)}  ${(job.company ?? "").slice(0, 21).padEnd(21)}  ${job.location ?? ""}\n`))
}

const HELP = `japan-boards-search

USAGE
  bun run src/cli.ts search [flags]
  bun run src/cli.ts detail <url> [--format json|plain]

SEARCH FLAGS
  --source <name>       tokyodev | japan-dev | relocate-me | all
  --query, -q <text>    Search terms. Default: Java backend
  --country <name>      Country filter. Japan is supported.
  --visa                Keep overseas, sponsorship, relocation, or no-Japanese signals
  --jobage <days>       Keep dated postings within N days (default: 45)
  --limit, -n <number>  Maximum results
  --format <format>     json (default) | table | plain
`

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2))
  const command = flags._[0]
  if (!command || flags.help) {
    process.stdout.write(HELP)
    return command ? 0 : 1
  }
  if (command === "search") {
    const sourceArg = typeof flags.source === "string" ? flags.source : "all"
    const sources: Source[] = sourceArg === "all" ? ["tokyodev", "japan-dev", "relocate-me"] : sourceArg === "tokyodev" || sourceArg === "japan-dev" || sourceArg === "relocate-me" ? [sourceArg] : []
    if (!sources.length) return writeError(`Unknown source: ${sourceArg}`, "BAD_SOURCE")
    const query = typeof flags.query === "string" ? flags.query : "Java backend"
    const limit = typeof flags.limit === "string" ? Math.max(1, Number(flags.limit)) : 30
    const jobage = typeof flags.jobage === "string" ? Math.max(1, Number(flags.jobage)) : 45
    if (!Number.isFinite(limit)) return writeError("--limit must be a number", "BAD_LIMIT")
    if (!Number.isFinite(jobage)) return writeError("--jobage must be a number", "BAD_JOBAGE")
    const results = interleaveBySource(filterJobs((await Promise.all(sources.map((source) => searchSource(source, query, limit)))).flat(), {
      query,
      country: typeof flags.country === "string" ? flags.country : undefined,
      visa: Boolean(flags.visa),
      jobage,
    }), limit)
    output(results, typeof flags.format === "string" ? flags.format : "json")
    return 0
  }
  if (command === "detail") {
    const url = flags._[1]
    if (!url || !/^https:\/\/(www\.)?(tokyodev\.com|japan-dev\.com|relocate\.me)\//i.test(url)) return writeError("detail requires a TokyoDev, Japan Dev, or Relocate.me URL", "BAD_URL")
    const html = await fetchText(url)
    const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html
    const detail = { url, title: cleanHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""), text: cleanHtml(body).slice(0, 50000) }
    process.stdout.write(typeof flags.format === "string" && flags.format === "plain" ? `${detail.title}\n${detail.text}\n` : JSON.stringify(detail, null, 2) + "\n")
    return 0
  }
  return writeError(`Unknown command: ${command}`, "BAD_COMMAND")
}

main().catch((error) => process.exit(writeError(String(error), "FETCH_FAILED")))
