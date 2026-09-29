// Render /report to app/static/medcost-report.pdf with headless Chromium.
//
//   node tools/render_report_pdf.js [base-url]      (default http://localhost:8092)
//
// Env: PLAYWRIGHT_CORE (module path), CHROMIUM (executable), REPORT_USER / REPORT_PASSWORD
// (Basic auth for the dev server; defaults read /root/stacks/medcost-dev/.dev-password).
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "/usr/lib/node_modules/openclaw/node_modules/playwright-core");

const base = process.argv[2] || "http://localhost:8092";
const pwFile = "/root/stacks/medcost-dev/.dev-password";
const password = process.env.REPORT_PASSWORD ?? (fs.existsSync(pwFile) ? fs.readFileSync(pwFile, "utf8").trim() : "");
const out = path.join(__dirname, "..", "app", "static", "medcost-report.pdf");

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || "/root/.cache/ms-playwright/chromium-1148/chrome-linux/chrome",
    args: ["--no-sandbox"],
  });
  const ctx = await browser.newContext({
    viewport: { width: 794, height: 1123 }, colorScheme: "light",
    httpCredentials: password ? { username: process.env.REPORT_USER || "dev", password } : undefined,
  });
  const page = await ctx.newPage();
  await page.goto(base + "/report");
  await page.waitForSelector("body[data-ready]");
  await page.emulateMedia({ media: "print", colorScheme: "light" });
  await page.pdf({ path: out, format: "A4", printBackground: true, preferCSSPageSize: true });
  await browser.close();
  console.log("wrote", out);
})();
