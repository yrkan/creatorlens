# Setting up creatorlens: the owner's checklist

Two parts: **Google Cloud** (about 40 minutes, once; only you can do it, in your own browser, signed in to your own
account) and **the Mac** (about 35 minutes for six channels). Every step that changes something is yours, typed in
your own Terminal: it asks you to type a confirmation and refuses a shell an assistant started. Never paste a token,
the client JSON or a key into a chat.

What the screens look like and what each error means: [google-cloud.md](google-cloud.md).

## Part 1. Google Cloud (about 40 minutes)

1. Open https://console.cloud.google.com/ signed in as the Google account that is the primary owner of your channels'
   Brand Accounts.
2. **Create one project for creatorlens.** Click the project picker at the top → **New project** → Project name
   `creatorlens (personal)` → Organization: *No organization* → **Create**, then select it in the picker. One project
   serves all six channels; never create one per channel, and never reuse a project another app uses (YouTube API
   Services Developer Policies III.D.1.c).
3. **Enable the three APIs.** Menu → **APIs & Services** → **Library**. Search for each one, open it, click **Enable**:
   1. YouTube Data API v3
   2. YouTube Analytics API
   3. YouTube Reporting API
4. **Describe the app.** Menu → **Google Auth Platform** (the old "OAuth consent screen" opens it too) → **Get started**:
   - App name: `creatorlens (personal)`. No "YouTube", "YT" or "Google" in the name: Google refuses them.
   - User support email: your address.
   - Audience: **External**.
   - Contact information: your address.
   - Tick the Google API Services User Data Policy → **Create**.
5. **Add exactly two scopes.** Google Auth Platform → **Data Access** → **Add or remove scopes** → in *Manually add
   scopes*, paste both lines, **Add to table**, then **Update** and **Save**:
   ```
   https://www.googleapis.com/auth/youtube.readonly
   https://www.googleapis.com/auth/yt-analytics.readonly
   ```
   Add nothing else. creatorlens refuses a sign-in that carries any other scope.
6. **Publish the app: "In production"** (our advice; the choice is yours). Google Auth Platform →
   **Audience** → Publishing status *Testing* → **Publish app** → **Confirm**. The status reads *In production*.
   - Why: while an app is in Testing, every sign-in dies after 7 days; a dead sign-in starts the 28-day deletion clock
     and would need six new sign-ins every week.
   - Do **not** click *Prepare for verification*: personal use (under 100 users) needs no verification. Google will show
     an "unverified app" warning at each sign-in, which is expected.
   - If you choose Testing instead: on the same page add your own Google account under *Test users*, and expect to run
     step 12 again every week.
7. **Create the Desktop client.** Google Auth Platform → **Clients** → **Create client** → Application type **Desktop
   app** → Name `creatorlens desktop` → **Create** → in the dialog that opens, click **Download JSON** at once (since
   June 2025 Google shows the secret only once; if you closed the dialog, add a new secret and download again). The file
   lands in `~/Downloads/client_secret_….json`. Keep it out of every git folder.
8. Nothing else in v0: no API key (version 2's public research will ask for one, restricted to the YouTube Data API v3).

## Part 2. On the Mac (about 35 minutes)

Run these in your own Terminal (not inside an assistant). Node must be v26.7.0: `node -v`, or `nvm use 26.7.0`.

9. **Build and test:**
   ```sh
   cd ~/WebstormProjects/creatorlens
   pnpm install --frozen-lockfile && pnpm build && pnpm test
   ```
10. **Install the pinned copy** (the schedule and the MCP server run this copy, never the repository):
    ```sh
    node dist/cli.js install          # type: install 0.1.0   (it runs the tests first)
    APP="$HOME/Library/Application Support/creatorlens/app/0.1.0/cli.js"
    ```
11. **Accept the terms and store the client:**
    ```sh
    node "$APP" setup --client-json ~/Downloads/client_secret_*.json      # read, then type: I accept
    ```
    Then delete the downloaded JSON: creatorlens keeps the secret in the Keychain.
12. **Sign in each channel**, one profile per language: `en`, `es`, `ru`, `fr`, `de`, `tr`.
    ```sh
    node "$APP" auth --profile en
    ```
    - The browser opens Google's sign-in. Choose your Google account, then the channel (the Brand Account) of that
      language.
    - Google says the app is not verified: check that the developer e-mail shown is yours → **Advanced** → **Go to …
      (unsafe)**.
    - Tick **both** boxes → **Continue**.
    - Back in Terminal, check the channel's name and ID, type `yes`, then answer `p` (In production).
    - Repeat for `es`, `ru`, `fr`, `de`, `tr` once each channel exists. Do not repeat auth without need: each run creates
      a new token, and Google keeps at most 100 per account per client (the oldest stops working silently).
13. **Create the Reporting jobs** for every profile:
    ```sh
    node "$APP" reporting enable --profile en     # type: enable en
    ```
    The first daily files arrive about 48 hours later; the 30 days before today arrive within a couple of days. Create the
    jobs within 30 days of the first upload, or that upload's first days are lost for good.
14. **First sync:** `node "$APP" sync --all --full`. Until the first files arrive, the jobs show *pending_first_report*.
15. **The daily schedule** for every profile:
    ```sh
    node "$APP" schedule install --profile en     # type: schedule en
    ```
    It runs at 07:30 and at login, and catches up after the Mac was off or asleep.
16. **Check:** `node "$APP" doctor --json` must say `"ok": true` for every profile (jobs waiting for their first file
    count as fine).
17. **Connect the assistant, in the analysis folder only:**
    ```sh
    mkdir -p ~/YouTube-analysis && cd ~/YouTube-analysis
    node "$APP" mcp-config
    ```
    Run the `claude mcp add --scope local creatorlens -- …` line it prints, inside `~/YouTube-analysis`, and merge the
    settings block it prints into `~/YouTube-analysis/.claude/settings.json` (deny rules for the Keychain read, the
    state-changing commands and the data folder). Keep the assistant's shell on "ask" in that folder: the deny rules
    are a net, the "ask" prompt is the wall (README, "Settings for the folder where you use it").
18. **Optional, recommended:** let every full purge also delete that folder's assistant transcripts:
    ```sh
    node "$APP" transcripts add ~/.claude/projects/-Users-<you>-YouTube-analysis     # type: yes
    ```
19. **About 48 hours later:** `node "$APP" status` shows the first files; `doctor --json` stays green.

## Later

- **An upgrade:** `git pull && pnpm install --frozen-lockfile && pnpm build && node dist/cli.js install`, then
  `schedule install` again for each profile (it points the schedule at the new copy) and restart your assistant. If
  the new version changed the terms, run `setup` again: until then the daily sync downloads nothing (it still runs the
  deletion clocks) and says why in `status`, `doctor` and a notification.
- **Stop everything for a channel:** `node "$APP" revoke --profile <p>` (asks whether to delete the jobs too).
- **A new channel later:** step 12, 13 and 15 for its profile.
