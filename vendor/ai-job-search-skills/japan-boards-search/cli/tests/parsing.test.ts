import { describe, expect, test } from "bun:test"
import { filterJobs, parseJapanDevPayload, type JobRecord } from "../src/cli"

function makeNuxtFixture(): string {
  const payload: unknown[] = [null, null, null, null]
  const add = (value: unknown) => {
    const index = payload.length
    payload.push(value)
    return index
  }
  const text = (value: string | null) => add(value)
  const addJob = (job: {
    id: string
    title: string
    slug: string
    company: string
    companySlug: string
    location: string
    date: string
    applicationUrl: string | null
    visa: string
    japanese: string
    english: string
    remote: string
    skills: string[]
    summary: string
    tags?: string[]
  }) => {
    const company = add({ name: text(job.company), slug: text(job.companySlug) })
    return add({
      id: text(job.id),
      title: text(job.title),
      slug: text(job.slug),
      company_name: text(job.company),
      location: text(job.location),
      job_post_date: text(job.date),
      application_url: text(job.applicationUrl),
      sponsors_visas: text(job.visa),
      japanese_level: text(job.japanese),
      english_level: text(job.english),
      remote_level: text(job.remote),
      skill_names: add(job.skills.map(text)),
      intro: text(job.summary),
      details: text(null),
      company,
      company_tag_names: add((job.tags ?? []).map(text)),
    })
  }

  const fresh = addJob({
    id: "100",
    title: "Backend Engineer",
    slug: "backend-engineer",
    company: "Example Corp",
    companySlug: "example-corp",
    location: "Tokyo, Japan",
    date: "Aug 19, 2026",
    applicationUrl: "https://apply.example/100",
    visa: "sponsors_visas_yes",
    japanese: "Not Required",
    english: "Business Level",
    remote: "remote_level_full",
    skills: ["Java", "Spring", "AWS"],
    summary: "<p>Build backend APIs</p>",
    tags: ["Sponsors Visas"],
  })
  const stale = addJob({
    id: "200",
    title: "Legacy Backend Engineer",
    slug: "legacy-backend-engineer",
    company: "Example Corp",
    companySlug: "example-corp",
    location: "Osaka, Japan",
    date: "2024-01-01",
    applicationUrl: null,
    visa: "sponsors_visas_no",
    japanese: "Required",
    english: "Business Level",
    remote: "remote_level_partial",
    skills: ["Java"],
    summary: "Old listing",
  })
  const outsideJapan = addJob({
    id: "300",
    title: "Backend Engineer",
    slug: "backend-engineer-global",
    company: "Global Corp",
    companySlug: "global-corp",
    location: "New York, United States",
    date: "Aug 19, 2026",
    applicationUrl: null,
    visa: "sponsors_visas_no",
    japanese: "Not Required",
    english: "Business Level",
    remote: "remote_level_full",
    skills: ["TypeScript"],
    summary: "Global backend work",
  })
  const sameId = addJob({
    id: "100",
    title: "Backend Engineer duplicate ID",
    slug: "backend-engineer-copy",
    company: "Example Corp",
    companySlug: "example-corp",
    location: "Tokyo, Japan",
    date: "Aug 19, 2026",
    applicationUrl: null,
    visa: "sponsors_visas_yes",
    japanese: "Not Required",
    english: "Business Level",
    remote: "remote_level_full",
    skills: ["Java"],
    summary: "Duplicate ID",
  })
  const sameSlug = addJob({
    id: "101",
    title: "Backend Engineer duplicate slug",
    slug: "backend-engineer",
    company: "Example Corp",
    companySlug: "example-corp",
    location: "Tokyo, Japan",
    date: "Aug 19, 2026",
    applicationUrl: null,
    visa: "sponsors_visas_yes",
    japanese: "Not Required",
    english: "Business Level",
    remote: "remote_level_full",
    skills: ["Java"],
    summary: "Duplicate slug",
  })

  const results = add([fresh, stale, outsideJapan, sameId, sameSlug, fresh])
  payload[0] = ["ShallowReactive", 1]
  payload[1] = { data: 2 }
  payload[2] = { "Job_production": 3 }
  payload[3] = { results }
  return `<script data-nuxt-data="nuxt-app" id="__NUXT_DATA__" type="application/json">${JSON.stringify(payload)}</script>`
}

const NUXT_FIXTURE = makeNuxtFixture()

describe("japan boards schema", () => {
  test("keeps the fields needed by the shared scraper workflow", () => {
    const job: JobRecord = {
      id: "test:1",
      source: "japan-dev",
      title: "Senior Java Backend Engineer",
      company: "Example",
      location: "Tokyo",
      postedDate: "2026-07-12",
      url: "https://japan-dev.com/jobs/example-1",
      applicationUrl: null,
      visaSignal: "visa sponsorship signal",
      languageSignal: "Not Required",
      workMode: "partial",
      skills: ["Java", "Backend"],
      summary: null,
    }
    expect(job.source).toBe("japan-dev")
    expect(job.visaSignal).toContain("visa")
    expect(job.skills).toContain("Java")
  })

  test("parses fresh Japan Dev jobs from Nuxt numeric references", () => {
    const jobs = parseJapanDevPayload(NUXT_FIXTURE)
    expect(jobs).toHaveLength(3)
    expect(jobs[0]).toMatchObject({
      id: "japan-dev:100",
      source: "japan-dev",
      title: "Backend Engineer",
      company: "Example Corp",
      location: "Tokyo, Japan",
      postedDate: "Aug 19, 2026",
      url: "https://japan-dev.com/jobs/example-corp/backend-engineer",
      applicationUrl: "https://apply.example/100",
      visaSignal: "visa sponsorship signal",
      languageSignal: "Not Required",
      workMode: "full",
      skills: ["Java", "Spring", "AWS"],
      summary: "Build backend APIs",
    })
  })

  test("applies local query, country, visa, age, and dedupe filters", () => {
    const jobs = parseJapanDevPayload(NUXT_FIXTURE)
    const now = Date.parse("2026-08-19T12:00:00Z")
    expect(filterJobs(jobs, { query: "backend engineer", country: "Japan", visa: true, jobage: 100, now })).toHaveLength(1)
    expect(filterJobs(jobs, { query: "Spring", country: "Japan", jobage: 100, now })[0]?.id).toBe("japan-dev:100")
    expect(filterJobs(jobs, { query: "backend", country: "Japan", jobage: 9999, now }).map((job) => job.id)).toEqual(["japan-dev:100", "japan-dev:200"])
    expect(filterJobs(jobs, { query: "backend", country: "Japan", jobage: 100, now }).map((job) => job.id)).toEqual(["japan-dev:100"])
  })

  test("fails clearly for missing or malformed Nuxt payloads", () => {
    expect(() => parseJapanDevPayload("<html></html>")).toThrow(/missing __NUXT_DATA__ payload/)
    expect(() => parseJapanDevPayload('<script id="__NUXT_DATA__" type="application/json">{</script>')).toThrow(/malformed JSON/)
  })
})
