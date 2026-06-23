import { MiniproTuiApp } from "./app";

const app = new MiniproTuiApp();

app.start().catch((error) => {
  console.error(error);
  process.exit(1);
});
