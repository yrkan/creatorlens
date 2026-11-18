# Contributing

Thank you for helping. creatorlens is small on purpose; these rules keep it trustworthy.

1. **Read-only stays read-only.** No new scope, no write method, no new host. A new Google request needs a route in
   `src/google/routes.ts` (GET only) and a test; anything that changes state at Google belongs in `src/admin/` and the
   CLI, never in the server.
2. **Google's figures as given.** No scores, rankings between channels, outlier ratios or sentiment
   (YouTube API Services Developer Policies III.E.4.h). Sum only additive figures of one channel, labelled.
3. **Strangers' text** goes into `untrusted_*` columns, is cleaned when stored and wrapped when returned.
4. **No real ids, no secrets.** Fixtures use channel ids starting `UCzz` and video ids starting `zz`
   (`test/hygiene.test.ts`); build fake tokens at run time so no literal matches a secret scanner. Install the hook:
   `sh scripts/install-hooks.sh`.
5. **No names with YouTube marks:** no "youtube", "tube" or "yt" as a word in any package, command, server, tool or
   label (`test/names.test.ts`).
6. **Dependencies:** a new production dependency needs a reason in `CHANGELOG.md` and an update of
   `scripts/deps-baseline.json`.
7. **Erasable TypeScript only** (Node runs the sources directly in tests): no enums, namespaces or parameter
   properties.

Before a pull request: `pnpm run typecheck`, `pnpm test`, `sh scripts/gitleaks.sh git`.
