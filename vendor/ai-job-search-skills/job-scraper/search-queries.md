# Search Queries for Job Scraper

Use these generic query patterns with the candidate's saved role, skill, and location criteria.

## Search Sites

Primary:
- **linkedin.com/jobs** - broad international and Indonesia remote/hybrid listings
- **freehire.dev** - tech-focused job aggregator for software/data/engineering roles
- **TokyoDev, Japan Dev, and Relocate.me** - Japan English-friendly and relocation-oriented roles
- **job boards added under .agents/skills/*-search/** - use each skill's documented CLI interface

Secondary:
- Direct company career pages for fintech, SaaS, logistics, cloud, data/AI platforms
- Google/Bing searches with site: filters when a portal CLI is not available

## Query Categories

Queries should be combined with the candidate's saved location terms where supported: preferred country, preferred city, remote, hybrid, APAC, and plausible international markets. Confirm relocation and onsite constraints before applying.

### Priority 1: Senior Java Backend / Spring Boot

`
 Senior Backend Engineer Java Spring Boot remote
Senior Java Developer microservices Kubernetes
Backend Engineer Java Spring Boot Kafka PostgreSQL
Lead Backend Engineer Java Spring Boot microservices
Java Backend Developer Redis Kafka Kubernetes
`

### Priority 2: Cloud-Native Platform / Microservices

`
Backend Platform Engineer Kubernetes microservices
Cloud Native Engineer Java Kubernetes Docker
Platform Engineer Spring Boot Kubernetes CI/CD
Microservices Engineer Java Kafka PostgreSQL
OpenShift Spring Boot backend engineer
`

### Priority 3: Fintech / High-Scale Transaction Systems

`
fintech Senior Backend Engineer Java
payments Java Backend microservices
banking Spring Boot Kubernetes Redis
financial services Backend Developer Kafka PostgreSQL
data encryption Java backend fintech
`

### Priority 4: Data / AI Platform Integration

`
AI Platform Engineer Java backend MCP
Data Platform Engineer Java Scala PostgreSQL Elasticsearch
Backend Engineer Neo4j Elasticsearch analytics
LLM integration backend engineer Java
MCP Backend Engineer
`

### Priority 5: Adjacent Full Stack Roles

`
Full Stack Engineer Java Spring Boot React TypeScript
Full Stack Developer microservices React PostgreSQL
Senior Full Stack Engineer Java Kubernetes
`

## Location Filter

Default acceptable areas to confirm:
- Remote roles based in the saved country or open to APAC candidates
- Hybrid roles in the saved city or metro area, subject to commute tolerance
- International remote roles if work authorization and timezone requirements fit

Flag before applying:
- Full onsite outside Jabodetabek
- Mandatory relocation
- Roles requiring work authorization not already held
- Heavy travel or unclear on-call expectations

## Date Filter

Only include jobs posted within the last 14 days, or with an application deadline that has not yet passed. If a posting date cannot be determined, include it but flag as date unknown.

## Adapting Queries

If the user specifies a focus area, select matching categories and generate 2-3 custom queries. Examples:
- scrape Japan visa -> run `japan-boards-search` with `Java backend`, `Spring Boot microservices`, or `backend platform Kubernetes`, plus `--country Japan --visa`
- scrape fintech -> prioritize fintech and high-scale transaction systems
- scrape ai platform -> prioritize data/AI platform integration
- scrape remote -> include remote/APAC terms and skip onsite-only results
