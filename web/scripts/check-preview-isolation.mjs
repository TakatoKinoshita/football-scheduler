import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIRECTORY = resolve(WEB_DIRECTORY, "dist");
const FORBIDDEN_MARKERS = [
  "bracket-preview.html",
  "/bracket-preview.html",
  "tournament-results-preview.html",
  "/tournament-results-preview.html",
  "TOURNAMENT_RESULTS_PREVIEW_FIXTURE_V1",
  "print-preview.html",
  "/print-preview.html",
  "PRINT_PREVIEW_FIXTURE_V1",
];

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  }));
  return nested.flat();
}

async function main() {
  try {
    const details = await stat(DIST_DIRECTORY);
    if (!details.isDirectory()) throw new Error("distがディレクトリではありません。");
  } catch (error) {
    throw new Error(
      "本番build成果物のdistがありません。先に npm run build を実行してください。",
      { cause: error },
    );
  }

  const violations = [];
  for (const path of await filesBelow(DIST_DIRECTORY)) {
    const outputPath = relative(DIST_DIRECTORY, path).replaceAll("\\", "/");
    for (const marker of FORBIDDEN_MARKERS) {
      if (outputPath.includes(marker)) violations.push(`${outputPath} (path: ${marker})`);
    }
    const contents = await readFile(path);
    for (const marker of FORBIDDEN_MARKERS) {
      if (contents.includes(Buffer.from(marker))) violations.push(`${outputPath} (content: ${marker})`);
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `ローカル比較専用の成果物が本番buildへ混入しています:\n${violations.map((item) => `- ${item}`).join("\n")}`,
    );
  }
  console.log("本番buildにローカル比較ページ、path、fixture markerが含まれていないことを確認しました。");
}

await main();
