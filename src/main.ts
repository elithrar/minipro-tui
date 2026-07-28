import { ChipDeskApp } from "./app";

const app = new ChipDeskApp();

app.start().catch((error) => {
  console.error(error);
  process.exit(1);
});
