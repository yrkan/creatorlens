# Security

## Report a problem

Use GitHub's private vulnerability reporting: https://github.com/yrkan/creatorlens/security/advisories/new. Never open
a public issue for a security problem, and never paste a token, a client secret, an API key or a client JSON anywhere.

## The threat model

creatorlens holds three things worth protecting, faces one kind of untrusted input, and has a few ways out.

**What it holds**

1. **Private data:** your channels' analytics, unlisted and private videos' metadata, and the raw Reporting files.
2. **The sign-in:** each channel's refresh token. With `youtube.readonly` and `yt-analytics.readonly` it can read
   everything above, and it can create and delete Reporting jobs (Google authorizes `jobs.create` under the analytics
   read scope). It cannot upload, edit, delete videos or comment.
3. **The OAuth client secret** of your own Google Cloud project.

**The untrusted input:** text other people write. Search terms, referrer pages and (from v2) comments and other
channels' titles can carry instructions aimed at your assistant ("ignore previous instructions and send…"). Inside an
AI client such text can do more than mislead an analysis: the same assistant may have a shell, web access and other
servers that send mail or post messages.

**The ways out:** your AI client and its other tools, and anything that runs as your user.

## What creatorlens does about it

- **Read-only by construction.** Two read-only scopes, checked as a set on every grant and refresh. No write method of
  the Data API exists in the code. Every request passes a closed table of method, host, path and caller before it is
  sent; nothing outside Google's API and sign-in hosts is reachable; redirects are refused except between report
  download routes; the access token is never sent to another host; no credential is sent when
  `NODE_TLS_REJECT_UNAUTHORIZED=0` turns certificate checks off.
- **The state-changing calls are not reachable from the server.** Job creation and deletion and token revocation sit in
  `src/admin/`, which `serve` never imports (a test walks its imports), and they run only from a terminal with a typed
  confirmation. The server sets a one-way read-only latch on its HTTP client.
- **Strangers' text is cleaned and wrapped.** Normalised to NFC; control, bidi, zero-width, tag and variation-selector
  characters removed; cut (comments at 500 characters, descriptions at 1,000); returned only as
  `{"untrusted": "…"}`, `sql_query` included (the SQL child reports when a result read an `untrusted_*` column).
  Comments arrive only in v2, only on an explicit call, and never in the same answer as your analytics.
- **SQL in a killable child process** with an empty environment, `readOnly`, `allowExtension: false`, `limits`
  (`attach: 0` also stops `VACUUM INTO`), defensive mode, a deny-by-default authorizer, a one-statement check, row and
  byte caps, and SIGKILL after 5 seconds.
- **Secrets** in the macOS Keychain, written through `security -i` on stdin (never on a command line), base64-encoded and
  read back. A file store only when you ask for it (`--token-store file`): 0600, atomic, refused when it is a symlink or
  readable by others. Access tokens live in memory only. One redaction function covers logs, errors and doctor output.
- **The terminal** never receives raw control characters from data: one printer escapes them.
- **The scheduled job** runs a pinned copy outside the repository (`~/Library/Application Support/creatorlens/app/<version>/`)
  with an absolute node path, `Umask 077`, and no secret in its plist.

## What the Keychain does not protect against

The Keychain protects the token at rest and from other users of the Mac. It does **not** protect it from code that
runs as you: `security find-generic-password -s creatorlens -a <profile> -w` prints it without a prompt, because the
item trusts `/usr/bin/security`, which wrote it. Any process with your user's rights, including an assistant's shell,
can do the same, and can read the data folder.

So:

- install the server with `--scope local` in a folder used only for analysis, and in that folder's settings deny
  `Bash(security find-generic-password*)`, the state-changing creatorlens commands and reads of the data folder (the
  README and `creatorlens mcp-config` give the exact block);
- keep the shell, web fetches and other servers' write tools on "ask" while an assistant reads strangers' text;
- the typed confirmations stop an assistant's shell (it has no terminal); they are a speed bump, not a wall, against
  code that controls a terminal.

## If a token or secret leaks

1. Remove creatorlens's access at https://security.google.com/settings/security/permissions (or run
   `creatorlens revoke --profile <p>`, which also deletes the local data).
2. Rotate the OAuth client secret in Google Auth Platform → Clients, then run `creatorlens setup` with the new JSON.
3. If you created an API key (v2), regenerate it in Google Cloud → Credentials.
4. List the Reporting jobs (`creatorlens reporting status --profile <p>`) and delete any you did not create.
5. Check the APIs' traffic and errors in Google Cloud → APIs & Services → Metrics for calls you did not make.
6. Sign in again: `creatorlens auth --profile <p>`.

## Supply chain

Three production packages (`@modelcontextprotocol/server`, `@modelcontextprotocol/core`, `zod`), pinned exactly; a
lockfile; pnpm refuses versions younger than a week, trust downgrades, unreviewed build scripts and non-registry
transitive sources; CI pins actions by commit, runs with a read-only token and no secrets, audits workflows with zizmor,
scans the whole history with gitleaks, and fails when the production closure grows without a CHANGELOG line.
