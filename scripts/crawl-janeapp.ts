// Re-crawls the clinic's JaneApp booking site to check the knowledge base
// against reality: practitioner roster, what each person is actually
// bookable for, and representative prices. JaneApp has no public API (would
// require "Technology Partner" approval), so this scrapes the booking pages
// with a real browser - treat its output as a diff to review by hand, not
// something to auto-write into the seed JSON. The pages are an internal SPA
// with no stability guarantee, so expect to adjust selectors if this breaks.
//
// One-time setup: `npx playwright install chromium`
// Usage: npm run crawl:janeapp -- https://joayotherapy.janeapp.com
//        (writes a JSON report to scripts/janeapp-crawl-report.json)
import { chromium, type Page } from "playwright";
import { writeFileSync } from "fs";

interface StaffSummary {
  id: string;
  name: string;
  categories: string[];
  bio: string | null;
  // true if the page didn't actually resolve to this person (e.g. a stale
  // or deleted staff_member id falls back to the generic "Our Team" booking
  // view) - this is exactly the bug that caught a phantom team member.
  looksInvalid: boolean;
}

async function dismissCookieBanner(page: Page) {
  try {
    await page.getByRole("button", { name: /allow all|accept/i }).click({ timeout: 2000 });
    await page.waitForTimeout(300);
  } catch {
    // no banner - fine
  }
}

async function getRoster(page: Page, baseUrl: string): Promise<{ id: string; name: string }[]> {
  await page.goto(`${baseUrl}/#/team`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(2500);
  await dismissCookieBanner(page);

  return page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="staff_member"]'));
    const seen = new Map<string, string>();
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/staff_member\/(\d+)/);
      if (!m) continue;
      const name = (a.textContent || "").trim();
      if (name && !seen.has(m[1])) seen.set(m[1], name);
    }
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
  });
}

async function getStaffSummary(
  browser: import("playwright").Browser,
  baseUrl: string,
  id: string,
  expectedName: string
): Promise<StaffSummary> {
  // Fresh context per staff member - reusing one page across hash-only
  // navigations was observed to occasionally serve stale SPA router state.
  const context = await browser.newContext({ viewport: { width: 1000, height: 1200 } });
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/#/staff_member/${id}`, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(2000);
    await dismissCookieBanner(page);
    try {
      await page.getByText(/read more/i).click({ timeout: 1500 });
      await page.waitForTimeout(300);
    } catch {
      // no truncated bio - fine
    }

    const data = await page.evaluate(() => {
      const nav = document.querySelector("nav.treatments");
      const categories = nav
        ? [...new Set(Array.from(nav.querySelectorAll("h3")).map((h) => h.textContent?.trim() ?? ""))]
        : [];
      return { categories, bodyText: document.body.innerText };
    });

    const text = data.bodyText;
    const start = text.indexOf("Back to Booking Page");
    const end = text.indexOf("Select a treatment");
    const bio = start !== -1 && end !== -1 ? text.slice(start + "Back to Booking Page".length, end).trim() : null;

    // A genuine individual page's bio block starts with that person's name.
    // The "Our Team" fallback (stale/invalid id) has no such block, or one
    // that doesn't mention the expected name.
    const looksInvalid = !bio || !bio.toLowerCase().includes(expectedName.split(" ")[0].toLowerCase());

    return { id, name: expectedName, categories: data.categories.filter(Boolean), bio, looksInvalid };
  } finally {
    await context.close();
  }
}

async function main() {
  const baseUrl = (process.argv[2] ?? "https://joayotherapy.janeapp.com").replace(/\/$/, "");

  const browser = await chromium.launch();
  const page = await browser.newPage();

  console.log(`Fetching roster from ${baseUrl}/#/team ...`);
  const roster = await getRoster(page, baseUrl);
  console.log(`Found ${roster.length} staff members.\n`);

  const summaries: StaffSummary[] = [];
  for (const { id, name } of roster) {
    process.stdout.write(`[${id}] ${name} ... `);
    const summary = await getStaffSummary(browser, baseUrl, id, name);
    summaries.push(summary);
    console.log(summary.looksInvalid ? "INVALID (page didn't resolve to this person)" : summary.categories.join(", "));
  }

  await browser.close();

  const reportPath = "scripts/janeapp-crawl-report.json";
  writeFileSync(reportPath, JSON.stringify({ crawledAt: new Date().toISOString(), baseUrl, staff: summaries }, null, 2));
  console.log(`\nReport written to ${reportPath}. Diff it against the seed JSON by hand before editing -`);
  console.log("this script only reports what JaneApp currently shows, it doesn't rewrite anything.");

  const invalid = summaries.filter((s) => s.looksInvalid);
  if (invalid.length > 0) {
    console.log(`\n${invalid.length} staff id(s) look invalid: ${invalid.map((s) => `${s.name} (${s.id})`).join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
