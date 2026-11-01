# ZoraForms

A Discord bot built with Sapphire, discord.js, and TypeScript. This initial project includes startup configuration, a ready listener, and a `/ping` slash command.

## Setup

Requires Node.js 22.12 or newer and npm.

1. Run `npm ci`.
2. Copy `.env.example` to `.env` and set `DISCORD_TOKEN` to your bot token.
3. Install your Discord application in a server with the `bot` and `applications.commands` scopes.
4. Run `npm run build` and then `npm start`.
5. Use `/ping` to check connectivity after Discord registers the command.

The bot requests the Guilds and DirectMessages intents, and supports uncached DM channels. Privileged Message Content access is not required for this starter. The form directory and questionnaire behavior are not implemented yet.

## Development

- `npm run check` — check TypeScript without emitting files.
- `npm run build` — compile to `dist/`.
- `npm run dev` — build and start once.
- `npm run watch:start` — rebuild and restart during development.
- `npm run generate` — generate Sapphire pieces with the official CLI.
- `npm run format` / `npm run format:check` — format or check source files.

Keep credentials in `.env`; only the empty `.env.example` template belongs in Git.
