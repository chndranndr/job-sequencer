# Changelog

## Unreleased

- Made validated `data/profile.json` the canonical structured profile.
- Preserved `data/profile.md` unchanged as a legacy backup/import source; the dashboard never edits both profiles independently.
- Added allowlisted runtime reuse of the six mapped vendored Markdown guidance files.
- Added truthful structured document-tailoring fields and actual document/tool status reporting.
- Added a capability-driven job-source plugin registry with bounded manifests, request policy enforcement, and reusable contract coverage.
- Cut the agent runtime over to the Qoder Agent SDK with pooled multi-turn interview sessions capped at eight jobs with a 15-minute TTL.
- Migrated legacy Pi provider settings to Qoder with an empty model instead of remapping them, and gated every live workflow on an explicitly selected Qoder model.
