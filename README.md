# ZoraForms

A SapphireJS and Discord.js bot for creating multiple forms, answering them through persistent DMs, and reviewing submissions in private staff threads.

## Run the bot

Requires Node.js 22.12 or newer, npm, PostgreSQL, and a Discord application installed in your server with the `bot` and `applications.commands` scopes.

1. Run `npm ci`.
2. Copy `.env.example` to `.env` and set `BotName`, `DISCORD_TOKEN`, and `DATABASE_URL`. `BotName` controls the displayed name in messages, command descriptions, and logs (1–50 characters).
3. Make sure PostgreSQL is running and that `DATABASE_URL` points to it.
4. Run `npm run build` and `npm start`. Startup applies the committed Drizzle migrations before connecting to Discord.
5. Use `/ping` to check the connection after Discord registers the commands.

The bot requests Guilds and DirectMessages intents and handles uncached DM channels; privileged Message Content access is unnecessary for this DM workflow.

## Create and publish a form

Form management requires Manage Server permission.

1. Create a staff-only standard text channel. Give the bot View Channel, Send Messages, Create Private Threads, Send Messages in Threads, Read Message History, Manage Threads, and Attach Files permissions. Give each reviewer access to the parent channel and permission to send in threads.
2. Run `/form create` with a name, review channel, and reviewer.
3. Use the panel to add text, choice, number, or attachment questions. Questions can be edited, removed, reordered, and marked optional.
4. Configure allowed, denied, and required roles, plus per-form blocked users, through Access. A denied role or blacklist takes precedence over an allowed role. Required roles must all be present; allowed roles require any match. Empty allow-lists impose no role restriction.
5. Configure lifetime and pending submission limits and a cooldown. Zero disables that particular limit. Configure submitted-answer retention from 1–365 days; the default is 30.
6. Use Publish. Configuration and review-channel permissions are checked before the form becomes available in DMs. Question and applicant-policy changes stay in the draft until published. Existing sessions keep their starting questions.

Use `/form list` to find form IDs and `/form manage` to reopen a panel. `/form blacklist` blocks or unblocks a user across the server. `/form archive` removes a form from the DM directory and prevents its unfinished sessions from submitting; it preserves the records. Publishing again reopens the form.

## Answer and review

Sending a first DM opens a paginated select menu containing eligible forms, labeled by server. The initial greeting is never saved as an answer. One unfinished questionnaire is allowed per person across all servers.

Each valid answer is saved before the next question is delivered. Back, Skip, Pause, and confirmed Cancel controls support navigation. Saved progress expires after seven days of inactivity. The final summary supports editing individual answers before Submit.

Attachments support PNG, JPEG, PDF, and UTF-8 text. Up to three files are accepted per attachment question, with an 8 MiB per-file limit and a 20 MiB limit across the questionnaire. Files are copied into the private directory configured by `ATTACHMENT_DIRECTORY`; expiring Discord URLs are not used as permanent storage. Mount and back up this directory with the database when moving the bot to a server. Run one bot deployment against this private directory.

Submit saves a durable application and queues one private staff review thread. Authorized reviewers use Accept or Reject, provide a reason, and the bot records the decision, queues the applicant notification, then locks and archives the thread. A blocked applicant DM does not undo the decision or prevent archival. Discord administrators and members with Manage Threads remain part of the thread's access boundary.

The reviewer roster is separate from applicant access: editing Staff review changes who can decide existing submissions immediately, and background synchronization updates pending thread invitations. Existing thread destinations remain pinned; `/form repair` can recover delivery failures. If thread creation has an uncertain result, automatic retries look for the existing thread. Explicit `recreate:true` is required when an administrator has verified that no matching thread exists.

Use My submissions in DMs to see recent status, or `/form submissions` as staff to inspect review-delivery status. Background retries preserve submissions through Discord outages. Retention removes stored answers, files, and the associated Discord review thread; minimal submission history remains to enforce lifetime limits. Cancelled drafts and expired progress are cleaned automatically while the bot runs.

## Database and development

- `npm run db:generate` — generate a reviewed migration from the TypeScript schema.
- `npm run db:migrate` — apply committed migrations.
- `npm run db:studio` — open Drizzle's local database browser while the database connection is available.
- `npm run check` — check TypeScript.
- `npm run build` — compile to `dist/`.
- `npm run watch:start` — rebuild and restart during development.
- `npm run format` / `npm run format:check` — format or check source and tests.
- `npm test` — run database, rendering, attachment, recovery, and simulated Discord lifecycle tests without a bot token.
- `npm run generate` — generate Sapphire pieces with its official CLI.

To exercise real PostgreSQL concurrency, set `ZORAFORMS_TEST_DATABASE_URL` to a dedicated database whose name ends in `_test`, build, and run `node --test tests/engine.test.cjs`. The test database is separate from the bot's application database.

The PostgreSQL Compose files are in `deploy/`. Provision `.secrets/postgres` and `.secrets/app` with independently generated passwords before starting Compose. Keep the secrets directory accessible only to its owner; the secret files must be readable by the container's PostgreSQL process. The initialization script expects generated hexadecimal passwords. Persistent data uses a named Docker volume. Back up the volume rather than deleting it during upgrades.

Only the empty `.env.example` belongs in Git. Local architecture notes and credentials are excluded. Live Discord verification requires a configured bot token and test server; the automated lifecycle suite uses simulated Discord responses.
