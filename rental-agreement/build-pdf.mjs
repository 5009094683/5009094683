#!/usr/bin/env node
// Rebuilds pdf/rental-agreement-<language>.pdf for every content.<language>.js file,
// using the Chrome, Chromium or Edge already installed on this computer.
//
//   node build-pdf.mjs
//
// Set the CHROME_PATH environment variable if the browser is not found automatically.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outputDir = join(here, "pdf");

const BROWSERS = [
  process.env.CHROME_PATH,
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser",
  "microsoft-edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);

function findBrowser() {
  return BROWSERS.find((candidate) =>
    isAbsolute(candidate)
      ? existsSync(candidate)
      : spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0
  );
}

function runBrowser(browser, args) {
  // A throwaway profile keeps this from attaching to a browser window that is already open.
  const profile = mkdtempSync(join(tmpdir(), "agreement-pdf-"));
  try {
    return spawnSync(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        `--user-data-dir=${profile}`,
        "--virtual-time-budget=5000",
        ...args,
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }
    );
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

const browser = findBrowser();
if (!browser) {
  console.error(
    "Chrome, Chromium or Edge was not found. Set CHROME_PATH to the browser's location,\n" +
      "or open agreement.html in a browser and use Print > Save as PDF."
  );
  process.exit(1);
}

const languages = readdirSync(here)
  .map((file) => /^content\.([\w-]+)\.js$/.exec(file))
  .filter(Boolean)
  .map((match) => match[1]);

// Returns a description of what went wrong, or null when the PDF was built.
function buildPdf(language) {
  const url = `${pathToFileURL(join(here, "agreement.html")).href}#${language}`;
  const output = join(outputDir, `rental-agreement-${language}.pdf`);

  // First pass: read the rendered page to check that the language loaded and everything fits.
  // If the browser gives no output here, the checks are skipped and the PDF is still built.
  const dump = runBrowser(browser, ["--dump-dom", url]);
  const htmlTag = /<html[^>]*>/.exec(dump.stdout || "")?.[0];
  if (htmlTag && !htmlTag.includes(`lang="${language}"`)) {
    return `content.${language}.js is not loaded. Add <script src="content.${language}.js"></script> to agreement.html.`;
  }

  rmSync(output, { force: true });
  const print = runBrowser(browser, ["--no-pdf-header-footer", `--print-to-pdf=${output}`, url]);
  if (!existsSync(output) || statSync(output).size === 0) {
    return `the browser did not produce a PDF (${print.error?.message ?? `exit code ${print.status}`}).`;
  }

  const overflow = htmlTag && /data-overflow="([^"]+)"/.exec(htmlTag);
  if (overflow) {
    return `the content does not fit on page ${overflow[1]}. Shorten the wording, or lower the sizes at the top of assets/agreement.css.`;
  }
  return null;
}

mkdirSync(outputDir, { recursive: true });
let failed = false;

for (const language of languages) {
  const problem = buildPdf(language);
  if (problem) {
    console.error(`ERROR  ${language}: ${problem}`);
    failed = true;
  } else {
    console.log(`built  pdf/rental-agreement-${language}.pdf`);
  }
}

process.exit(failed ? 1 : 0);
