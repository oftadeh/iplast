# Instructions for AI coding assistants

Read `docs/DEVELOPMENT.md` first (Persian): architecture, data rules, code conventions, workflow and the production server.
Then `docs/BUILD.md` for install/deploy/backup, and `packages/db/prisma/schema.prisma` for the data model.

Hard rules:
- Never commit secrets. They live only in `/opt/iplast/.env` and `/opt/iplast-tls` on the server.
- Merging into `main` deploys to production automatically. Work on a branch, open a PR, merge only when the owner says so.
- Never invent prices or demo data; a missing price is `NULL` and shown as «استعلامی». Money is BigInt Rial.
- Never add a migration that deletes data without the owner's explicit approval.
- User-facing text is Persian; code comments are English. Match the style of the neighbouring files.
- Run `pnpm typecheck` (and `apps/api/test/e2e.mjs` for flow changes) before opening a PR.
- Talk to the owner in Persian.
