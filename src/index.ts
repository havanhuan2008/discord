import app from "./app.js";
import { logger } from "./lib/logger.js";
import { startDiscordBot } from "./lib/discord-bot.js";

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  logger.info({ port }, "Server listening");

  startDiscordBot().catch((err) => {
    logger.error({ err }, "Discord bot failed to start");
  });
});
