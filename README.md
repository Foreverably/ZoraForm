# ZoraForms

A SapphireJS and Discord.js bot for multiple forms, persistent DM questionnaires, and submission threads in a configured Discord channel.

## Setup

Requires Node.js 22.12 or newer, npm, PostgreSQL, and a Discord application installed in your server with the `bot` and `applications.commands` scopes.

1. Run `npm ci`.
2. Copy `.env.example` to `.env` and configure `BotName`, `DISCORD_TOKEN`, and `DATABASE_URL`. The displayed bot name accepts 1–50 characters.
3. Make sure PostgreSQL is running and that `DATABASE_URL` points to it.
4. Run `npm run build` and `npm start`. Committed Drizzle migrations are applied before Discord login.
5. Use `/ping` after Discord registers the commands.

Only Guilds and DirectMessages intents are requested, with support for uncached DM channels.

## Staff permissions

Members with Manage Server or Administrator have all staff capabilities without configuration. Those are Discord permissions, not role names.

Other staff can receive individual capabilities through a user grant, a role grant, or both:

| Capability           | Allows                                                                          |
| -------------------- | ------------------------------------------------------------------------------- |
| `forms.create`       | Creating drafts                                                                 |
| `forms.edit`         | Editing questions, details, access rules, policies, and submission destinations |
| `forms.publish`      | Publishing or reopening a form                                                  |
| `forms.archive`      | Closing a form to applicants                                                    |
| `forms.blacklist`    | Blocking or unblocking users and roles                                          |
| `submissions.decide` | Accepting or rejecting a submission                                             |
| `submissions.reply`  | Sending an applicant a staff reply                                              |
| `submissions.repair` | Recovering failed submission delivery                                           |

Only members with Manage Server or Administrator can grant or revoke capabilities:

```text
/form permission action:submissions.decide allowed:true role:@Reviewers
/form permission action:submissions.reply allowed:true user:@Moderator
/form permission action:forms.edit allowed:false role:@FormerEditors
```

Exactly one user or role must be selected. Grants are server-specific and checked against live membership on each action. Permission to reply does not grant permission to decide, and permission to edit does not grant permission to publish. Discord command visibility remains configurable through Discord's own integration settings; the bot enforces capability checks independently.

## Create forms

Run `/form create` with a name and submission channel, then use the interactive builder to add, edit, remove, reorder, and preview questions. Text, numbers, single-choice answers, and attachments are supported. Choosing a question opens its editor, where each setting changes on its own: wording, required or optional, answer limits, whole numbers only, and answer choices.

The builder updates one message as you navigate, save a modal, or return with Back. Modals use Discord Label components. Staff review provides a native text-channel picker.

### Reference files

Staff can show 1–3 screenshots or documents with a question, up to 8 MiB each and 20 MiB per question. The bot keeps them in a message in the form's submission channel and stores only that message's identifiers, so anyone who can read the channel can see them. Do not delete that message while forms or saved questionnaires use it.

Replacing files, removing them, or removing their question retires the old message. Questionnaires already in progress stay on the revision they started with, so the bot deletes a retired message automatically once no form draft, published form, or unfinished questionnaire uses it. Files on an archived form stay available because the form can be reopened.

Publishing fails if a reference file is no longer available. If one disappears after publishing, applicants still receive the question, with a notice in place of the missing file. Temporary download failures retry instead of sending the question without its files.

Use Access for allowed roles, required roles, blacklisted roles, and blocked users on one form. Searchable role and user menus add or remove up to 25 entries per selection without replacing the rest of a list (up to 100 entries per list). Blacklist changes need `forms.blacklist` and apply immediately, including to the published form; allowed and required roles stay in the draft until Publish. Denials take precedence: any blacklisted role blocks access, all required roles must be present, and at least one allowed role must be present when an allow-list is configured. An empty allow-list imposes no role restriction.

Use `/form blacklist` to block a user or role from every form in the server:

```text
/form blacklist blocked:true role:@Restricted
/form blacklist blocked:false user:@Applicant
```

Submission policies configure lifetime and pending limits plus a cooldown. Zero disables a particular limit. Submitted answers are retained for 1–365 days, with 30 days as the default. Question, allowed-role, required-role, and policy edits stay in the draft until Publish; blacklists take effect immediately.

Publishing validates the submission channel, the bot's permissions, question configuration, and role references. `/form list` opens a paginated browser where selecting a form opens its management panel, which holds every form action including Publish, Archive, and Submissions. Previews include every question and choice, with pagination for long content.

## Channel visibility and staff actions

The configured channel's Discord permissions determine who can read submissions. The bot creates one channel-visible public thread per submission; it does not maintain an invitation list or a separate reader role list. Here, public means visible to members who can view the parent channel. Configure a staff-only parent channel in Discord when submissions should be restricted to staff.

The bot needs View Channel, Send Messages, Create Public Threads, Send Messages in Threads, Read Message History, Manage Threads, and Attach Files in the submission channel.

Reading a thread does not grant permission to act on the submission. Accept and Reject require `submissions.decide`; Reply requires `submissions.reply`. Reply queues a DM to the applicant and records a copy in the submission thread without changing the decision. Final decisions queue the applicant notification and lock and archive the thread. Failed applicant DMs do not undo a saved decision or block archival. There is no Claim or Request Information workflow.

`/form submissions` lists the forms whose submission channel the member can read, then paginates each form's submissions; staff can also reach them from a form's management panel. Members with `submissions.repair` get a recovery menu for pending submissions, which reconciles existing threads before retrying. If no thread is found, a replacement is only created after confirming through a separate button.

## Applicant DMs and attachment transfer

A first DM opens a paginated menu of eligible forms, labeled by server. The greeting is never saved as an answer. One unfinished questionnaire is allowed per user across all servers, with saved progress for seven days of inactivity.

Answers are saved before advancing. Back, Skip, Pause, Resume, confirmed Cancel, and a final paginated answer summary support navigation and correction. My submissions provides complete paginated status history. Roles, blacklists, and submission policies are rechecked during progress and at submission.

Attachment answers store only source DM channel, message, and attachment identifiers plus basic metadata in PostgreSQL. Files are not saved in a local bot directory or as database binary data. On delivery, the bot force-fetches the original message to refresh the attachment URL, buffers the file in memory, uploads it to the submission thread, and releases the buffer.

Up to three files are accepted per attachment question, up to 8 MiB per file and 20 MiB across the questionnaire. The original DM upload must remain available until delivery completes. The confirmation step checks that uploads are still available; missing uploads can be corrected through Edit answer before Submit. Once the copy is in the submission thread, it no longer depends on the original DM attachment. Discord delivery failures are retried from durable jobs.

## Anti-spam and retention

PostgreSQL-backed rate limits are shared across workers and survive restarts. Per user, each ten-second window permits eight DM messages, fifteen component interactions, and six form commands, with a combined ceiling of twenty requests. Repeated blocked DM requests do not generate repeated warning messages. These limits are separate from per-form submission limits and cooldowns.

Retention removes saved answer content, source attachment metadata, staff replies, and the associated submission thread. Minimal submission history remains to enforce lifetime limits. Cancellation and draft expiry clean up saved progress and attachment references while the bot runs. The bot does not delete applicants' original DM messages.

## Database and development

- `npm run db:generate` — generate a migration from the typed schema.
- `npm run db:migrate` — apply committed migrations.
- `npm run db:studio` — start Drizzle's local database browser.
- `npm run check` — typecheck application and tooling configuration.
- `npm run build` — clean and compile the bot to `dist/`.
- `npm run watch:start` — rebuild and restart while developing.
- `npm run format` / `npm run format:check` — format or verify source and tests.
- `npm test` — test persistence, permissions, rate limits, browsing, attachment transfer, and simulated Discord workflows without a token.
- `npm run generate` — generate Sapphire pieces with its CLI.

For real PostgreSQL concurrency checks, set `ZORAFORMS_TEST_DATABASE_URL` to a dedicated database whose name ends in `_test`, build, and run the database tests. Never use the application database for test fixtures.

PostgreSQL Compose files are in `deploy/`. Independently generated hexadecimal passwords belong in `.secrets/postgres` and `.secrets/app`, outside Git. Keep the secrets directory owner-only and its mounted files readable by the PostgreSQL container process. Preserve and back up the named database volume. No separate bot-side attachment directory is required.

Architecture notes and actual environment values remain outside Git. Live Discord verification still requires a configured bot token and test server.
