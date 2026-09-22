#!/usr/bin/env node
import { register } from "tsx/esm/api";

register();
const { startMcpServer } = await import("../src/index.ts");

startMcpServer().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
