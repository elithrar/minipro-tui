const [mode, value = ""] = process.argv.slice(2);

if (mode === "emit") {
  process.stdout.write(value);
} else if (mode === "sleep") {
  await Bun.sleep(Number(value) || 5000);
} else if (mode === "ignore-term-and-output") {
  process.on("SIGTERM", () => undefined);
  process.stdout.write(value);
  await Bun.sleep(5000);
}
