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
    // Default to same directory and filename with .pdf extension
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

  // Extract headings for Table of Contents (H1 and H2)
  console.log("📑 Extracting headings for TOC...");
  const lines = markdownContent.split("\n");
  const headings = [];
  let insideCodeBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      insideCodeBlock = !insideCodeBlock;
      continue;
    }
    if (insideCodeBlock) continue;

    const h1Match = line.match(/^#\s+(.+)$/);
    if (h1Match) {
      const text = h1Match[1].trim();
      const id = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      headings.push({ level: 1, text, id });
    }

    const h2Match = line.match(/^##\s+(.+)$/);
    if (h2Match) {
      const text = h2Match[1].trim();
      const id = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      headings.push({ level: 2, text, id });
    }
  }

  // Generate TOC HTML
  let tocHtml = "";
  if (headings.length > 0) {
    tocHtml += `<div class="toc">
  <h2>Table of Contents</h2>
  <ul>
`;
    let currentH1 = null;
    for (const heading of headings) {
      if (heading.level === 1) {
        if (currentH1) {
          tocHtml += `      </ul>
    </li>
`;
        }
        tocHtml += `    <li><a href="#${heading.id}">${heading.text}</a>
      <ul>
`;
        currentH1 = heading;
      } else if (heading.level === 2) {
        tocHtml += `        <li><a href="#${heading.id}">${heading.text}</a></li>
`;
      }
    }
    if (currentH1) {
      tocHtml += `      </ul>
    </li>
`;
    }
    tocHtml += `  </ul>
</div>\n`;
  }

  // Configure marked with custom heading renderer to include IDs
  marked.use({
    renderer: {
      heading({ text, depth }) {
        const id = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
        return `<h${depth} id="${id}">${text}</h${depth}>\n`;
      }
    }
  });

  console.log("🔨 Converting markdown to HTML...");
  const contentHtml = await marked.parse(markdownContent);

  // Assemble full HTML with premium styling
  const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Riverside OS Printable Guide</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    * {
      box-sizing: border-box;
    }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      line-height: 1.6;
      color: #1e293b;
      max-width: 850px;
      margin: 0 auto;
      padding: 40px 20px;
      font-size: 14px;
      background-color: #ffffff;
    }

    /* Headings */
    h1, h2, h3, h4 {
      font-family: 'Outfit', sans-serif;
      font-weight: 600;
      color: #0f172a;
    }
    h1 {
      font-size: 26px;
      border-bottom: 2px solid #e2e8f0;
      padding-bottom: 12px;
      margin-top: 40px;
      margin-bottom: 20px;
      page-break-before: always;
    }
    h1:first-of-type {
      page-break-before: avoid;
      margin-top: 0;
    }
    h2 {
      font-size: 20px;
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
      font-size: 18px;
      color: #0f172a;
      border-bottom: 1px solid #e2e8f0;
      padding-bottom: 8px;
    }
    .toc ul {
      list-style: none;
      padding-left: 0;
      margin: 0;
    }
    .toc ul ul {
      padding-left: 20px;
      margin-top: 4px;
    }
    .toc li {
      margin: 8px 0;
      font-weight: 500;
    }
    .toc ul ul li {
      font-weight: 400;
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
    .task-list-item {
      list-style-type: none;
      margin-left: -20px;
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
      box-shadow: 0 1px 3px rgba(0,0,0,0.01);
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
      h1, h2, h3, h4, h5, h6 {
        page-break-after: avoid;
      }
    }
  </style>
</head>
<body>
  <div style="margin-bottom: 20px; text-align: right; font-size: 11px; color: #64748b; font-family: 'Outfit', sans-serif; letter-spacing: 0.5px;">
    RIVERSIDE OS RELEASE COMPLIANCE
  </div>

  ${tocHtml}

  ${contentHtml}

  <footer style="margin-top: 60px; padding-top: 20px; border-top: 1px solid #e2e8f0; color: #64748b; font-size: 11px; text-align: center; font-family: 'Outfit', sans-serif;">
    Riverside OS Operations &bull; Confidential &bull; Standard Work Procedures
  </footer>
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
    margin: {
      top: "1.5cm",
      bottom: "1.5cm",
      left: "1.5cm",
      right: "1.5cm"
    },
    displayHeaderFooter: true,
    headerTemplate: "<div></div>", // Hide default header
    footerTemplate: `
      <div style="font-family: 'Inter', sans-serif; font-size: 8px; width: 100%; display: flex; justify-content: space-between; padding: 0 1.5cm; color: #94a3b8; font-weight: 500;">
        <span>Riverside OS v0.70.2 Deployment Guide</span>
        <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
      </div>
    `
  });

  await browser.close();
  console.log(`\n✅ PDF Export Complete!`);
  console.log(`📁 Saved to: ${outputPath}`);
}

main().catch((error) => {
  console.error("❌ Error generating PDF:", error);
  process.exit(1);
});
