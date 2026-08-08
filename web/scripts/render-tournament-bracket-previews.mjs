import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const WEB_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_IDS = ["upper-8", "upper-7-seeded", "upper-9-seeded", "upper-16"];

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function selectedFixtures() {
  const requested = option("--fixture") ?? "all";
  if (requested === "all") return FIXTURE_IDS;
  if (!FIXTURE_IDS.includes(requested)) {
    throw new Error(`未対応のfixtureです: ${requested}`);
  }
  return [requested];
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("ローカルプレビュー用ポートを確保できませんでした。");
  }
  await new Promise((resolvePromise, reject) =>
    server.close((error) => error === undefined ? resolvePromise() : reject(error))
  );
  return address.port;
}

async function waitForServer(url, processOutput) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Viteがlistenするまで短く待つ。
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
  throw new Error(`Viteの起動を確認できませんでした。\n${processOutput()}`);
}

function stopServer(server) {
  if (server.exitCode !== null || server.pid === undefined) return;
  if (process.platform === "win32") server.kill("SIGTERM");
  else process.kill(-server.pid, "SIGTERM");
}

async function main() {
  const fixtures = selectedFixtures();
  const layout = option("--layout") ?? "standard";
  const requestedOutput = option("--output-dir");
  const outputDirectory = requestedOutput === undefined
    ? await mkdtemp(join(tmpdir(), "football-scheduler-bracket-previews-"))
    : resolve(requestedOutput);
  await mkdir(outputDirectory, { recursive: true });
  const port = await availablePort();
  const origin = `http://127.0.0.1:${String(port)}`;
  const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
  const serverOutput = [];
  const vite = spawn(
    npmExecutable,
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: WEB_DIRECTORY,
      detached: process.platform !== "win32",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  vite.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
  vite.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
  const outputText = () => serverOutput.join("").slice(-4000);
  let browser;
  try {
    await waitForServer(`${origin}/bracket-preview.html`, outputText);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1720, height: 1200 } });
    for (const fixture of fixtures) {
      const parameters = new URLSearchParams({ fixture, layout });
      await page.goto(`${origin}/bracket-preview.html?${parameters.toString()}`);
      await page.locator('body[data-preview-ready="true"]').waitFor();
      const error = page.locator(".preview-error");
      if (await error.count() > 0) throw new Error(await error.first().innerText());
      const path = join(outputDirectory, `${fixture}-${layout}.png`);
      await page.locator("#preview-output svg").screenshot({ path, animations: "disabled" });
      console.log(path);
    }
  } finally {
    await browser?.close();
    stopServer(vite);
  }
}

await main();
