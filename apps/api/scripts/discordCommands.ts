/**
 * Registers `/ask` and `/board` with Discord, for every server the application is in. Run once, and again
 * after changing `ASK_COMMAND` or `BOARD_COMMAND`: pnpm --filter @dno/api discord:commands
 * Reads DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN (Developer Portal → Bot → Reset Token) from
 * the environment or the repo-root .env. The token is needed here only, never by the API.
 */
import { existsSync } from "node:fs";
import { ASK_COMMAND, BOARD_COMMAND } from "../src/infrastructure/discord/DiscordClerk";

const envFile = new URL("../../../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { DISCORD_APPLICATION_ID: app, DISCORD_BOT_TOKEN: token } = process.env;
if (!app || !token) throw new Error("set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN");

// PUT replaces the application's whole set of global commands with these.
const res = await fetch(`https://discord.com/api/v10/applications/${app}/commands`, {
  method: "PUT",
  headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
  body: JSON.stringify([ASK_COMMAND, BOARD_COMMAND]),
});
const body = await res.text();
if (!res.ok) throw new Error(`Discord refused the commands (${res.status}): ${body}`);
console.log(`registered: ${(JSON.parse(body) as { name: string }[]).map((c) => `/${c.name}`).join(", ")}`);
console.log(`add them to a server: https://discord.com/oauth2/authorize?client_id=${app}&scope=applications.commands`);
