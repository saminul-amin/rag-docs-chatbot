/**
 * Takes the README / portfolio screenshots (1920x1440, 4:3) from a running server.
 *
 *   npm run build && npm start          # in one terminal
 *   npm run screenshots                 # in another (BASE_URL=... to point elsewhere)
 *
 * Uses Playwright with the Microsoft Edge or Chrome already installed on the machine
 * (BROWSER_CHANNEL=chrome to switch), so no browser download is needed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = path.resolve("docs/screenshots");
const CHANNEL = process.env.BROWSER_CHANNEL ?? "msedge";

const browser = await chromium.launch({ channel: CHANNEL });

async function newPage(workspace) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 960 },
    deviceScaleFactor: 1.5,
    colorScheme: "light",
  });
  await context.addInitScript((id) => localStorage.setItem("askdocs-workspace", id), workspace);
  const page = await context.newPage();
  await page.goto(BASE);
  await page.getByText("passages indexed").first().waitFor({ timeout: 120_000 });
  return page;
}

async function ask(page, question) {
  const done = page.getByText(/passages · \d/);
  const before = await done.count();
  const box = page.getByPlaceholder(/Ask a question/);
  await box.fill(question);
  await box.press("Enter");
  await done.nth(before).waitFor({ timeout: 90_000 });
  await page.waitForTimeout(300);
}

async function openSource(page, n) {
  const chips = page.getByRole("button", { name: `Show source ${n}` });
  await chips.last().click();
  await page.waitForTimeout(1600); // let the highlight flash fade
}

async function shot(page, name) {
  await page.evaluate(() => {
    const el = document.querySelector("main .overflow-y-auto");
    if (el) el.scrollTop = 0;
  });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(OUT, name) });
  console.log("saved", name);
}

const stamp = Date.now().toString(36);

// 1. A cited answer with an expanded source passage.
{
  const page = await newPage(`screens-a-${stamp}-0000000`);
  await ask(page, "How many vacation days do new employees get, and can they carry them over?");
  await openSource(page, 1);
  await shot(page, "01-cited-answer.png");
  await page.context().close();
}

// 2. An answer, then a question the documents don't cover.
{
  const page = await newPage(`screens-b-${stamp}-0000000`);
  await ask(page, "My espresso machine shows E04. What should I do?");
  await ask(page, "Do you offer a pension plan?");
  await shot(page, "02-not-in-docs.png");
  await page.context().close();
}

// 3. The visitor's own Word document, uploaded and queried.
{
  const workspace = `screens-c-${stamp}-0000000`;
  const form = new FormData();
  const file = "scripts/fixtures/Brightfield SLA.docx";
  form.append("file", new Blob([readFileSync(file)]), path.basename(file));
  const res = await fetch(`${BASE}/api/documents`, {
    method: "POST",
    headers: { "x-workspace-id": workspace },
    body: form,
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  const page = await newPage(workspace);
  // Search only the uploaded document.
  for (const label of await page.locator("aside label").all()) {
    if (!(await label.innerText()).includes("Brightfield")) await label.locator("input").uncheck();
  }
  await ask(page, "What service credit do we get if uptime drops below 99%?");
  await openSource(page, 1);
  await shot(page, "03-upload.png");
  await page.context().close();
}

await browser.close();
