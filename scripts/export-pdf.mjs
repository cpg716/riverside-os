#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { marked } from "marked";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function usage() {
  console.log(`Usage: node scripts/export-pdf.mjs <markdown-file> [--output <output-file>]
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    usage();
    process.exit(0);
  }

  const inputFile = args[0];
  let outputFile = null;

  const outIndex = args.indexOf("--output");
  if (outIndex !== -1 && args[outIndex + 1]) {
    outputFile = args[outIndex + 1];
  } else {
    const parsed = path.parse(inputFile);
    outputFile = path.join(parsed.dir, `${parsed.name}.pdf`);
  }

  const inputPath = path.resolve(REPO_ROOT, inputFile);
  const outputPath = path.resolve(REPO_ROOT, outputFile);

  if (!fs.existsSync(inputPath)) {
    console.error(`❌ File not found: ${inputFile}`);
    process.exit(1);
  }

  console.log(`📖 Reading: ${inputFile}`);
  const markdownContent = fs.readFileSync(inputPath, "utf-8");

  // Parse title & version from the first H1
  let bodyMarkdown = markdownContent;
  let docTitle = "Riverside OS Guide";
  let version = "0.70.2";

  const h1Match = markdownContent.match(/^#\s+(.+)$/m);
  if (h1Match) {
    docTitle = h1Match[1].trim();
    // Strip the main H1 title from the body markdown so it doesn't repeat on page 2
    bodyMarkdown = markdownContent.replace(/^#\s+(.+)$/m, "");
  }

  const versionMatch = docTitle.match(/v?(\d+\.\d+\.\d+)/);
  if (versionMatch) {
    version = versionMatch[1];
  }

  // Extract H2 headings for Table of Contents (from body markdown)
  console.log("📑 Extracting headings for TOC...");
  const lines = bodyMarkdown.split("\n");
  const headings = [];
  let insideCodeBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      insideCodeBlock = !insideCodeBlock;
      continue;
    }
    if (insideCodeBlock) continue;

    const h2Match = line.match(/^##\s+(.+)$/);
    if (h2Match) {
      const text = h2Match[1].trim();
      const id = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      headings.push({ level: 2, text, id });
    }
  }

  // Generate TOC HTML (relative to H2s under the main cover page)
  let tocHtml = "";
  if (headings.length > 0) {
    tocHtml += `<div class="toc">
  <h2>Table of Contents</h2>
  <ul>
`;
    for (const heading of headings) {
      tocHtml += `    <li><a href="#${heading.id}">${heading.text}</a></li>\n`;
    }
    tocHtml += `  </ul>
</div>\n`;
  }

  // Configure marked with custom heading renderer
  marked.use({
    renderer: {
      heading({ text, depth }) {
        const id = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
        return `<h${depth} id="${id}">${text}</h${depth}>\n`;
      }
    }
  });

  console.log("🔨 Converting markdown to HTML...");
  const contentHtml = await marked.parse(bodyMarkdown);

  // Cover Page HTML
  const coverPageHtml = `
  <div class="cover-page">
    <div class="cover-top">
      <div class="cover-badge">RELEASE COMPLIANCE DOCUMENT</div>
      <div style="display: flex; align-items: center; gap: 16px; margin-top: 10px;">
        <svg class="cover-logo" viewBox="0 0 100 100" width="48" height="48">
          <path d="M50 15 L85 35 L85 65 L50 85 L15 65 L15 35 Z" fill="none" stroke="#2563eb" stroke-width="5"/>
          <path d="M50 28 L73 41 L73 59 L50 72 L27 59 L27 41 Z" fill="#2563eb"/>
        </svg>
        <span style="font-family: 'Outfit', sans-serif; font-size: 28px; font-weight: 700; color: #0f172a; letter-spacing: -0.5px;">RIVERSIDE OS</span>
      </div>
    </div>
    
    <div class="cover-middle">
      <h1 class="cover-title">${docTitle}</h1>
      <p class="cover-tagline">Authoritative reference manual for store hardware configuration, software package updates, schema migrations, and backup verification.</p>
    </div>

    <div class="cover-details">
      <table class="cover-details-table">
        <tr>
          <td>Target Version</td>
          <td>v${version}</td>
        </tr>
        <tr>
          <td>Document Classification</td>
          <td>Operational Standard Work</td>
        </tr>
        <tr>
          <td>Authorized Stations</td>
          <td>Server PC / Register #1 / Register #2 (iPad) / Counterpoint PC</td>
        </tr>
        <tr>
          <td>Generated On</td>
          <td>${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</td>
        </tr>
      </table>
    </div>

    <div class="cover-footer-text">
      CONFIDENTIAL &bull; INTERNAL STORE OPERATIONS ONLY &bull; DO NOT DISTRIBUTE
    </div>
  </div>
  `;

  // Assemble full HTML with cover page and page style setups
  const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${docTitle}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    /* CSS @page definitions for margin controls */
    @page {
      size: A4;
      margin: 1.6cm 1.5cm;
    }
    @page :first {
      margin: 0 !important;
    }

    * {
      box-sizing: border-box;
    }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      line-height: 1.6;
      color: #1e293b;
      max-width: 850px;
      margin: 0 auto;
      font-size: 14px;
      background-color: #ffffff;
    }

    /* Cover Page Styles */
    .cover-page {
      page-break-after: always;
      page-break-inside: avoid !important;
      height: 96vh; /* Viewport-relative height to prevent rounding overflows */
      max-height: 96vh;
      width: 100%;
      padding: 2.5cm 2cm;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      box-sizing: border-box;
      background-color: #ffffff;
      margin: 0 auto;
    }
    .cover-badge {
      font-size: 10px;
      font-family: 'Outfit', sans-serif;
      letter-spacing: 2px;
      color: #2563eb;
      font-weight: 700;
      text-transform: uppercase;
    }
    .cover-logo {
      color: #2563eb;
    }
    .cover-middle {
      border-left: 4px solid #2563eb;
      padding-left: 28px;
      margin: auto 0;
      page-break-inside: avoid !important;
    }
    .cover-title {
      font-family: 'Outfit', sans-serif;
      font-size: 38px;
      font-weight: 700;
      line-height: 1.15;
      color: #0f172a;
      margin: 0 0 16px 0;
      border-bottom: none;
      padding-bottom: 0;
      page-break-before: avoid !important;
      page-break-inside: avoid !important;
    }
    .cover-tagline {
      font-size: 14px;
      line-height: 1.6;
      color: #475569;
      margin: 0;
      max-width: 540px;
    }
    .cover-details {
      margin-bottom: auto;
      margin-top: 2cm;
      max-width: 500px;
    }
    .cover-details-table {
      width: 100%;
      border-collapse: collapse;
    }
    .cover-details-table td {
      border: none;
      padding: 10px 0;
      font-size: 13px;
    }
    .cover-details-table tr {
      border-bottom: 1px solid #f1f5f9;
      background-color: transparent !important;
    }
    .cover-details-table tr:last-child {
      border-bottom: none;
    }
    .cover-details-table td:first-child {
      font-family: 'Outfit', sans-serif;
      font-weight: 600;
      color: #64748b;
      width: 200px;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.5px;
    }
    .cover-details-table td:last-child {
      color: #0f172a;
      font-weight: 500;
    }
    .cover-footer-text {
      font-family: 'Outfit', sans-serif;
      font-size: 10px;
      letter-spacing: 1px;
      color: #94a3b8;
      text-align: center;
      margin-top: auto;
      font-weight: 600;
    }

    /* Guide Body Styles */
    .guide-body {
      padding: 0 20px;
    }

    /* Headings */
    h1, h2, h3, h4 {
      font-family: 'Outfit', sans-serif;
      font-weight: 600;
      color: #0f172a;
    }
    h1 {
      font-size: 24px;
      border-bottom: 2px solid #e2e8f0;
      padding-bottom: 12px;
      margin-top: 40px;
      margin-bottom: 20px;
      page-break-before: always;
    }
    h2 {
      font-size: 18px;
      margin-top: 32px;
      margin-bottom: 16px;
      padding-bottom: 6px;
      border-bottom: 1px solid #f1f5f9;
      color: #1e3a8a; /* Deep Slate Blue */
    }
    h3 {
      font-size: 15px;
      margin-top: 24px;
      margin-bottom: 12px;
      color: #334155;
    }

    /* Table of Contents */
    .toc {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 24px 30px;
      margin-bottom: 40px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.02);
    }
    .toc h2 {
      margin-top: 0;
      font-size: 16px;
      color: #0f172a;
      border-bottom: 1px solid #e2e8f0;
      padding-bottom: 8px;
    }
    .toc ul {
      list-style: none;
      padding-left: 0;
      margin: 0;
    }
    .toc li {
      margin: 8px 0;
      font-weight: 500;
    }
    .toc a {
      color: #2563eb;
      text-decoration: none;
    }
    .toc a:hover {
      text-decoration: underline;
    }

    /* Paragraphs and Lists */
    p {
      margin-top: 0;
      margin-bottom: 16px;
      color: #334155;
    }
    ul, ol {
      padding-left: 24px;
      margin-top: 0;
      margin-bottom: 16px;
    }
    li {
      margin: 6px 0;
      color: #334155;
    }

    /* Premium custom checklist styles */
    li input[type="checkbox"] {
      -webkit-appearance: none;
      appearance: none;
      width: 14px;
      height: 14px;
      border: 1.5px solid #2563eb;
      border-radius: 3px;
      outline: none;
      display: inline-block;
      vertical-align: middle;
      position: relative;
      top: -1.5px;
      margin-right: 8px;
      background-color: #fff;
    }
    li input[type="checkbox"]:checked {
      background-color: #2563eb;
    }
    li input[type="checkbox"]:checked::after {
      content: '';
      position: absolute;
      left: 4px;
      top: 1px;
      width: 3px;
      height: 6px;
      border: solid white;
      border-width: 0 1.5px 1.5px 0;
      transform: rotate(45deg);
    }
    li:has(input[type="checkbox"]) {
      list-style-type: none;
      margin-left: -16px;
    }

    /* Code blocks */
    pre {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 14px 18px;
      overflow-x: auto;
      font-size: 12.5px;
      line-height: 1.5;
      margin: 16px 0;
    }
    code {
      font-family: 'JetBrains Mono', 'SF Mono', monospace;
      font-size: 12.5px;
      color: #0f172a;
    }
    p code, li code {
      background: #f1f5f9;
      padding: 2px 5px;
      border-radius: 4px;
      color: #0f172a;
      font-size: 12px;
    }

    /* Tables */
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 24px 0;
      font-size: 12.5px;
    }
    th, td {
      border: 1px solid #e2e8f0;
      padding: 10px 14px;
      text-align: left;
    }
    th {
      background: #f8fafc;
      font-weight: 600;
      color: #0f172a;
      border-bottom: 2px solid #cbd5e1;
    }
    tr:nth-child(even) {
      background: #fdfdfd;
    }
    tr:nth-child(even) td {
      background-color: #f8fafc;
    }

    /* Horizontal Rules */
    hr {
      border: 0;
      border-top: 1px solid #e2e8f0;
      margin: 32px 0;
    }

    /* Blockquotes */
    blockquote {
      border-left: 4px solid #2563eb;
      margin: 20px 0;
      padding: 12px 20px;
      background: #f8fafc;
      color: #475569;
      border-radius: 0 8px 8px 0;
    }

    /* Links */
    a {
      color: #2563eb;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }

    /* Print styles */
    @media print {
      body {
        padding: 0;
        color: #000;
      }
      .toc {
        page-break-after: always;
        box-shadow: none;
      }
      pre {
        white-space: pre-wrap;
        word-wrap: break-word;
        background: #f8fafc !important;
        border: 1px solid #cbd5e1 !important;
      }
      th {
        background: #f1f5f9 !important;
      }
      tr {
        page-break-inside: avoid;
      }
      table {
        page-break-inside: avoid !important;
      }
      h1, h2, h3, h4, h5, h6 {
        page-break-after: avoid;
        page-break-inside: avoid;
      }
    }
  </style>
</head>
<body>

  ${coverPageHtml}

  <div class="guide-body">
    <div style="margin-bottom: 20px; text-align: right; font-size: 11px; color: #64748b; font-family: 'Outfit', sans-serif; letter-spacing: 0.5px;">
      RIVERSIDE OS RELEASE COMPLIANCE
    </div>

    ${tocHtml}

    ${contentHtml}

    <footer style="margin-top: 60px; padding-top: 20px; border-top: 1px solid #e2e8f0; color: #64748b; font-size: 11px; text-align: center; font-family: 'Outfit', sans-serif;">
      Riverside OS Operations &bull; Confidential &bull; Standard Work Procedures
    </footer>
  </div>
</body>
</html>`;

  // Start Playwright
  console.log("🌐 Launching headless browser with Playwright...");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log("⏳ Setting page content...");
  await page.setContent(fullHtml, { waitUntil: "networkidle" });

  // Ensure fonts are loaded before printing
  await page.evaluate(() => document.fonts.ready);

  console.log(`🖨️ Rendering PDF to ${outputFile}...`);
  await page.pdf({
    path: outputPath,
    format: "A4",
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: "<div></div>", // Hide default header
    footerTemplate: `
      <div style="font-family: 'Inter', sans-serif; font-size: 8px; width: 100%; display: flex; justify-content: space-between; padding: 0 1.5cm; color: #94a3b8; font-weight: 500;">
        <span>Riverside OS v${version} Deployment Guide</span>
        <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
      </div>
    `,
    margin: {
      top: "1.6cm",
      bottom: "1.6cm",
      left: "1.5cm",
      right: "1.5cm"
    }
  });

  await browser.close();
  console.log(`\n✅ PDF Export Complete!`);
  console.log(`📁 Saved to: ${outputPath}`);
}

main().catch((error) => {
  console.error("❌ Error generating PDF:", error);
  process.exit(1);
});
