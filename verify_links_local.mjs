import fs from 'fs';
import path from 'path';

const baseDir = '.';
const docDir = 'docs';
const glossaryPath = path.join(baseDir, 'GLOSSARY.md');

// Read glossary to extract valid anchors
const glossaryContent = fs.readFileSync(glossaryPath, 'utf-8');
const anchors = new Set();
const headingRegex = /^## (.+)$/gm;
let match;
while ((match = headingRegex.exec(glossaryContent)) !== null) {
  const slug = match[1]
    .toLowerCase()
    .replace(/[\s/]+/g, '-')
    .replace(/[^\w\-]/g, c => encodeURIComponent(c));
  anchors.add(slug);
}

console.log(`Found ${anchors.size} glossary anchors`);

// Walk docs and check links
let brokenCount = 0;
function walkDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) walkDir(fullPath);
    else if (file.endsWith('.md')) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
      while ((match = linkRegex.exec(content)) !== null) {
        const url = match[2];
        if (url.includes('GLOSSARY.md#')) {
          const anchor = url.split('#')[1];
          if (!anchors.has(anchor)) {
            console.log(`BROKEN: ${fullPath} → #${anchor}`);
            brokenCount++;
          }
        }
      }
    }
  }
}

walkDir(docDir);
console.log(`\nBroken links: ${brokenCount}`);
process.exit(brokenCount > 0 ? 1 : 0);
