import { startServer } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const app = await startServer(port);
console.log(`Personal Job Search listening on http://127.0.0.1:${port}`);

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
