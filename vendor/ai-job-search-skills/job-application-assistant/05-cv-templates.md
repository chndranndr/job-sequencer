# CV Templates and Tailoring Guide

Use only verified candidate facts. Canonical variants live in `cv/variants/`; application-specific source files are copies in `cv/source/`, compiled PDFs go to `cv/pdf/`, and LaTeX build artifacts go to `cv/build/`. Do not regenerate a CV from scratch for every posting.

## Canonical CV Variants

| Variant | Use for | Current source |
|------|---------|----------------|
| `backend_java_spring` | Senior Java/Spring Boot backend, microservices, API/platform, distributed systems, and cloud-native backend roles | `cv/variants/backend_java_spring.tex` |

## Reuse Decision

1. Select the closest canonical variant after fit evaluation.
2. Copy it to `cv/source/main_<company>_<role>.tex`; preserve the canonical variant unchanged.
3. Reuse the copy unchanged when its positioning and supported keywords already match.
4. Tailor only when a material difference exists: platform/SRE emphasis, data/AI integration, full-stack emphasis, job language, seniority, or genuinely supported keywords missing from the variant.
5. Always create a job-specific cover letter, even when the CV copy is unchanged.

The copied CV remains part of the application record and must still be compiled and verified before use.

## Primary Positioning

Choose the positioning that best matches the verified profile and the posting. Common examples include senior Java/Spring Boot backend, microservices, event-driven architecture, cloud-native/Kubernetes, production reliability, full-stack Java/React, platform engineering, and AI/data platform integration.

## Profile Statement Templates

### Senior Java Backend / Microservices
Senior backend engineer with [verified years] of experience building [verified systems] with Java/Spring Boot. Strong evidence of [verified outcomes] through microservices, event-driven architecture, data-store optimization, cloud-native delivery, or reliability work.

### Cloud-Native Platform / Reliability
Backend and infrastructure engineer with verified production experience across [confirmed platforms], CI/CD, observability, and services. Delivered [confirmed outcomes] and is best suited for teams that need ownership of scalable backend services and reliable platforms.

### Data / AI Platform Integration
Engineer with verified backend depth plus experience integrating [confirmed data or AI workflows] with APIs, databases, analytics services, or agent tools. Use only the integration work the candidate can substantiate.

## Core Competency Set

Use 5-7 confirmed items, ordered by the posting:

- **Backend engineering:** Java, Spring Boot, Quarkus, REST APIs, microservices, reusable backend libraries.
- **Event-driven systems:** Kafka, RabbitMQ, async processing, throughput, resilience.
- **Data stores:** PostgreSQL, MySQL, Redis, Elasticsearch, Neo4j, indexing, database views.
- **Cloud-native delivery:** Kubernetes, OpenShift, Docker, AWS, GCP, CI/CD, Jenkins, Ansible.
- **Production reliability:** observability, monitoring, runbooks, uptime, incident response.
- **Full-stack delivery:** React, TypeScript, dashboard modules, large-dataset UX.
- **AI/data integration:** MCP, LLM workflow integration, internal APIs, analytics services.

## Tailoring Rules

- Lead with the verified experience most relevant to the role.
- Use the posting's language only when the candidate can support it.
- Do not claim formal people management, ML research, or provider depth without confirmation.
- Keep every metric exactly as sourced; omit unsupported metrics.
- Keep the canonical variant unchanged and record job-specific changes in the copied source.

## Compile Requirements

All CVs must compile with lualatex and fit exactly 2 pages. Use `pdftotext -layout` for ATS text-layer verification when available.
