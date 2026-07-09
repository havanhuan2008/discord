import app from "./app";
import { logger } from "./lib/logger";
import { startDiscordBot } from "./lib/discord-bot";

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  logger.info({ port }, "Server listening");

  startDiscordBot().catch((err) => {
    logger.error({ err }, "Discord bot failed to start");
  });
});
