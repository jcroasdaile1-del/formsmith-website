import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const dataSource = fs.readFileSync(path.join(root, "assets/js/site-data.js"), "utf8");
const context = { window: {} };
vm.createContext(context);
vm.runInContext(dataSource, context, { filename: "site-data.js" });
const data = context.window.FORMSMITH_DATA;
const marketingPageNames = ["demos", "portfolio", "industries", "pricing", "about", "faq", "contact", "quote", "privacy"];
const pages = [
  "index.html",
  ...marketingPageNames.map((name) => `${name}/index.html`),
  "404.html",
  ...(data?.projects || []).map((project) => project.detailPath)
];

const errors = [];
const titles = new Map();
const productionMode = process.argv.includes("--production");

function fail(file, message) {
  errors.push(`${file}: ${message}`);
}

function localTargetExists(page, target) {
  let clean = target.split("#")[0].split("?")[0];
  if (!clean || /^(?:[a-z]+:|\/\/)/i.test(clean)) return true;
  if (clean.startsWith("/formsmith-website/")) clean = clean.slice("/formsmith-website/".length);
  else if (clean.startsWith("/")) clean = clean.slice(1);
  let candidate = path.resolve(root, path.dirname(page), clean);
  if (clean.endsWith("/")) candidate = path.join(candidate, "index.html");
  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) candidate = path.join(candidate, "index.html");
  return fs.existsSync(candidate);
}

for (const page of pages) {
  const fullPath = path.join(root, page);
  if (!fs.existsSync(fullPath)) {
    fail(page, "missing page");
    continue;
  }
  const html = fs.readFileSync(fullPath, "utf8");
  const title = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim();
  if (!title) fail(page, "missing title");
  else if (titles.has(title)) fail(page, `duplicates title used by ${titles.get(title)}`);
  else {
    titles.set(title, page);
    if (!/Formsmith Custom Forms/.test(title)) fail(page, "title does not use the full Formsmith Custom Forms brand");
  }

  if (page !== "404.html") {
    if (!/<meta\s+name="description"\s+content="[^"]+"/i.test(html)) fail(page, "missing meta description");
    const canonical = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i)?.[1];
    if (!canonical) fail(page, "missing canonical URL");
    else {
      try {
        const canonicalUrl = new URL(canonical);
        if (canonicalUrl.protocol !== "https:") fail(page, "canonical URL must use HTTPS");
      } catch {
        fail(page, `invalid canonical URL: ${canonical}`);
      }
      if (/YOUR-DOMAIN|REPLACE[_-]?ME/i.test(canonical)) fail(page, "canonical URL still contains a placeholder");
    }
    if (!/<meta\s+property="og:title"\s+content="[^"]+"/i.test(html)) fail(page, "missing Open Graph title");
    if (!/<meta\s+property="og:description"\s+content="[^"]+"/i.test(html)) fail(page, "missing Open Graph description");
    const openGraphUrl = html.match(/<meta\s+property="og:url"\s+content="([^"]+)"/i)?.[1];
    if (!openGraphUrl || /YOUR-DOMAIN|REPLACE[_-]?ME/i.test(openGraphUrl)) fail(page, "missing or placeholder Open Graph URL");
    if (/<meta\s+name="robots"\s+content="[^"]*noindex/i.test(html)) fail(page, "canonical page must not use noindex");
    if (/<title>[^<]*\bmoved\b|This page has moved to/i.test(html)) fail(page, "canonical page contains legacy redirect-stub content");
  }
  if (!/<main\b[^>]*id="main-content"/i.test(html)) fail(page, "missing main-content landmark");
  if (!/class="skip-link"[^>]*href="#main-content"/i.test(html)) fail(page, "missing skip link");
  if (!/data-site-header/.test(html)) fail(page, "missing shared header mount");
  if (!/data-site-footer/.test(html)) fail(page, "missing shared footer mount");
  if (/href=["']#["']/i.test(html)) fail(page, "contains an empty placeholder link");

  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicateIds.length) fail(page, `duplicate IDs: ${[...new Set(duplicateIds)].join(", ")}`);

  for (const match of html.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)) {
    const target = match[1];
    if (!localTargetExists(page, target)) fail(page, `broken local reference: ${target}`);
  }

  for (const image of html.matchAll(/<img\b[^>]*>/gi)) {
    if (!/\balt="[^"]*"/i.test(image[0])) fail(page, `image missing alt: ${image[0].slice(0, 80)}`);
    if (!/\bwidth="\d+"/i.test(image[0]) || !/\bheight="\d+"/i.test(image[0])) fail(page, "image missing explicit width or height");
  }

  for (const schema of html.matchAll(/<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      JSON.parse(schema[1]);
    } catch (error) {
      fail(page, `invalid JSON-LD: ${error.message}`);
    }
  }
}

const homepage = fs.readFileSync(path.join(root, "index.html"), "utf8");
if (!homepage.includes('<meta name="google-site-verification" content="nCVhhoy3ZZJ3LjnII79lQBiOBTAcBBpg5Sn8o4FK3ew" />')) {
  fail("index.html", "missing the permanent Google Search Console verification tag");
}
if (!/<script\s+async\s+src="https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-TKHRMCW79P"><\/script>/i.test(homepage)) {
  fail("index.html", "GA4 gtag.js must be present in the raw homepage head");
}
if (!/gtag\(['"]config['"],\s*['"]G-TKHRMCW79P['"]\)/.test(homepage)) {
  fail("index.html", "raw homepage does not configure the GA4 property");
}

for (const demoFile of fs.readdirSync(root).filter((file) => /-demo\.html$/i.test(file))) {
  const demoHtml = fs.readFileSync(path.join(root, demoFile), "utf8");
  if (!/<meta\s+name="robots"\s+content="[^"]*noindex/i.test(demoHtml)) fail(demoFile, "standalone demo must use noindex");
  if (!/<link\s+rel="canonical"\s+href="https:\/\/[^"]+"/i.test(demoHtml)) fail(demoFile, "standalone demo is missing an HTTPS canonical");
  if (/FormsmithCustomForms|formsmithcustomforms@gmail\.com/i.test(demoHtml)) fail(demoFile, "standalone demo still exposes a legacy sales channel");
}

const sitemap = fs.readFileSync(path.join(root, "sitemap.xml"), "utf8");
const sitemapUrls = new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]));
for (const page of pages.filter((item) => item !== "404.html")) {
  const html = fs.readFileSync(path.join(root, page), "utf8");
  const canonical = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i)?.[1];
  if (canonical && !sitemapUrls.has(canonical)) fail("sitemap.xml", `missing canonical URL for ${page}: ${canonical}`);
}
if (/YOUR-DOMAIN|REPLACE[_-]?ME/i.test(sitemap)) fail("sitemap.xml", "contains a placeholder URL");

if (!data) fail("assets/js/site-data.js", "does not define window.FORMSMITH_DATA");
else {
  if (!Array.isArray(data.projects) || data.projects.length < 1) fail("assets/js/site-data.js", "must define at least one project");
  if (data.site?.name !== "Formsmith Custom Forms") fail("assets/js/site-data.js", "primary site name must be Formsmith Custom Forms");
  if (data.industries.length !== 11) fail("assets/js/site-data.js", `expected 11 industries, found ${data.industries.length}`);
  if (data.faqs.length < 14) fail("assets/js/site-data.js", `expected at least 14 FAQs, found ${data.faqs.length}`);
  if (!data.faqs.some((faq) => faq.question === "Will I own my business data?" && /^Yes\. You will own your business data\./.test(faq.answer))) {
    fail("assets/js/site-data.js", "business-data ownership FAQ must provide an explicit yes");
  }
  const budgetLabels = data.quoteOptions.budgetRanges.map((option) => option.label);
  const expectedBudgets = ["I am not sure yet", "Under $500", "$500-$1,000", "$1,000-$2,499", "$2,500-$4,999", "$5,000+"];
  if (JSON.stringify(budgetLabels) !== JSON.stringify(expectedBudgets)) fail("assets/js/site-data.js", `unexpected budget ranges: ${budgetLabels.join(" | ")}`);
  if (budgetLabels.at(-1) !== "$5,000+") fail("assets/js/site-data.js", "budget ranges must end with $5,000+");
  const contact = data.site.contact;
  if (contact.email !== "formsmithcustomforms@gmail.com" || contact.phoneHref !== "+14143955816" || contact.facebookUrl !== "https://www.facebook.com/FormsmithCustomForms/" || contact.etsyUrl !== "https://www.etsy.com/shop/FormsmithCustomForms" || contact.isPlaceholder) {
    fail("assets/js/site-data.js", "configured email, phone, Facebook, Etsy, or placeholder status is incorrect");
  }
  for (const project of data.projects) {
    if (project.status === "Live Demo" && !(project.screenshots || []).some((screenshot) => screenshot.src)) {
      fail("assets/js/site-data.js", `${project.slug} is a live demo without a real screenshot`);
    }
    for (const [label, target] of [["detail", project.detailPath], ["demo", project.demo?.url]]) {
      if (target && !localTargetExists("index.html", target)) fail("assets/js/site-data.js", `${project.slug} has broken ${label} path: ${target}`);
    }
    if (project.demo?.url && !/^(?:[a-z]+:|\/\/)/i.test(project.demo.url)) {
      const demoPath = project.demo.url.endsWith("/") ? `${project.demo.url}index.html` : project.demo.url;
      const demoHtml = fs.readFileSync(path.join(root, demoPath), "utf8");
      const detailHtml = fs.readFileSync(path.join(root, project.detailPath), "utf8");
      const detailCanonical = detailHtml.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i)?.[1];
      const demoCanonical = demoHtml.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i)?.[1];
      if (!/<meta\s+name="robots"\s+content="[^"]*noindex/i.test(demoHtml)) fail(demoPath, "configured demo must use noindex");
      if (!detailCanonical || demoCanonical !== detailCanonical) fail(demoPath, "configured demo canonical must match its project detail page");
      if (/FormsmithCustomForms|formsmithcustomforms@gmail\.com/i.test(demoHtml)) fail(demoPath, "configured demo still exposes a legacy sales channel");
    }
    for (const screenshot of project.screenshots || []) {
      if (!localTargetExists("index.html", screenshot.src)) fail("assets/js/site-data.js", `${project.slug} has broken screenshot path: ${screenshot.src}`);
      if (!screenshot.alt) fail("assets/js/site-data.js", `${project.slug} screenshot is missing alt text`);
      if (!screenshot.width || !screenshot.height) fail("assets/js/site-data.js", `${project.slug} screenshot is missing dimensions`);
    }
  }
}

for (const name of marketingPageNames) {
  const legacyPage = `${name}.html`;
  const legacyPath = path.join(root, legacyPage);
  if (!fs.existsSync(legacyPath)) {
    fail(legacyPage, "missing legacy redirect stub");
    continue;
  }
  const html = fs.readFileSync(legacyPath, "utf8");
  const cleanUrl = `https://getformsmith.com/${name}/`;
  if (!/<meta\s+name="robots"\s+content="[^"]*noindex/i.test(html)) fail(legacyPage, "redirect stub must use noindex");
  if (!html.includes(`<link rel="canonical" href="${cleanUrl}">`)) fail(legacyPage, "redirect stub canonical is incorrect");
  if (!/<meta\s+http-equiv="refresh"\s+content="0;\s*url=\.\/[a-z-]+\/"/i.test(html)) fail(legacyPage, "redirect stub is missing its clean-URL refresh");
}

if (productionMode && data) {
  const contact = data.site.contact;
  if (!data.site.customDomain || data.site.canonicalBaseUrl !== data.site.customDomain) {
    fail("assets/js/site-data.js", "production mode requires matching customDomain and canonicalBaseUrl values");
  }
  for (const page of pages.filter((page) => page !== "404.html")) {
    const html = fs.readFileSync(path.join(root, page), "utf8");
    const canonical = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i)?.[1] || "";
    const openGraphUrl = html.match(/<meta\s+property="og:url"\s+content="([^"]+)"/i)?.[1] || "";
    if (!canonical.startsWith(data.site.customDomain) || !openGraphUrl.startsWith(data.site.customDomain)) {
      fail(page, "production canonical and Open Graph URLs must use the configured custom domain");
    }
  }
  if (contact.isPlaceholder || !contact.email || !contact.phoneHref || !contact.facebookUrl || !contact.etsyUrl) {
    fail("assets/js/site-data.js", "production mode requires active email, phone, Facebook, Etsy, and isPlaceholder=false");
  }
  for (const [name, form] of Object.entries(data.site.forms).filter(([name]) => name !== "privacy")) {
    if (form.mode !== "endpoint" || !form.endpoint) fail("assets/js/site-data.js", `production mode requires a configured ${name} endpoint`);
    if (!form.provider || form.provider === "none") fail("assets/js/site-data.js", `production mode requires a named ${name} form provider`);
  }
  if (/REPLACE[_-]?ME|hello@REPLACE-ME|\(000\) 000-0000/i.test(dataSource)) {
    fail("assets/js/site-data.js", "production mode still contains contact placeholders");
  }
  const contactPage = fs.readFileSync(path.join(root, "contact/index.html"), "utf8");
  if (/once the final contact details .* configured|awaiting configuration/i.test(contactPage)) {
    fail("contact/index.html", "production mode still contains preview-only contact wording");
  }
  const privacyPage = fs.readFileSync(path.join(root, "privacy/index.html"), "utf8");
  if (/forms are not connected|may later connect|will be documented when|will be added before|awaiting configuration/i.test(privacyPage)) {
    fail("privacy/index.html", "production mode requires the final provider, retention, and privacy-contact wording");
  }
}

const quote = fs.readFileSync(path.join(root, "quote/index.html"), "utf8");
if ((quote.match(/\bdata-form-step\b/g) || []).length !== 5) fail("quote/index.html", "quote wizard must have exactly 5 form steps");
if ((quote.match(/\bdata-progress-step\b/g) || []).length !== 5) fail("quote/index.html", "quote wizard must have exactly 5 progress steps");
if (!/name="privacyAgreement"[^>]*required/.test(quote)) fail("quote/index.html", "privacy agreement is not required");
if (!/class="quote-card"\s+id="quote-form"/.test(quote)) fail("quote/index.html", "quote form anchor is missing");
if (!/id="business-website"[^>]*type="text"[^>]*placeholder="example\.com"/.test(quote) || !/https:\/\/ is not required/i.test(quote)) {
  fail("quote/index.html", "business website field must accept a domain without requiring https://");
}

const contactPage = fs.readFileSync(path.join(root, "contact/index.html"), "utf8");
if (/How should we address you\?|Where should we reply\?/i.test(contactPage)) fail("contact/index.html", "removed contact helper prompt is still present");
if (!/class="form-card"\s+id="contact-form"/.test(contactPage)) fail("contact/index.html", "contact form anchor is missing");

const marketingCopy = ["index.html", "demos/index.html", "pricing/index.html", "faq/index.html", "privacy/index.html", "quote/index.html"].map((page) => fs.readFileSync(path.join(root, page), "utf8")).join("\n");
if (/\bhost(?:ing|ed|s)?\b/i.test(`${marketingCopy}\n${dataSource}`)) fail("marketing copy", "still refers to hosting");

if (errors.length) {
  console.error(`Site check failed with ${errors.length} issue${errors.length === 1 ? "" : "s"}:`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

console.log(`Site check passed${productionMode ? " in production mode" : ""}: ${pages.length} pages, ${data.projects.length} projects, ${data.industries.length} industries, and ${data.faqs.length} FAQs.`);
