import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(full));
    else files.push(full);
  }
  return files;
}

const files = await filesUnder(root);
const textFiles = files.filter((file) => ['.json', '.md', '.mdx', '.mjs', '.yml', '.yaml'].includes(extname(file)));

const clonedTerms = [
  /boostgpt/iu,
  /boostgpt\.co/iu,
  /discord\.gg\/(?:KGhz5SnyXM|mt8pGkgUZj)/iu,
];

for (const file of textFiles) {
  if (file.endsWith('scripts/audit.mjs')) continue;
  const content = await readFile(file, 'utf8');
  for (const pattern of clonedTerms) {
    if (pattern.test(content)) failures.push(`${relative(root, file)} contains cloned-product content matching ${pattern}`);
  }

  const fenced = [...content.matchAll(/```[^\n]*\n([\s\S]*?)```/gu)].map((match) => match[1]).join('\n');
  const secretPatterns = [
    /sk_(?:live|test)_[A-Za-z0-9_-]{20,}/gu,
    /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/gu,
    /\bAKIA[0-9A-Z]{16}\b/gu,
    /X-Scrinly-Provider-API-Key:\s*(?!\$(?:OPENAI|DEEPSEEK|PROVIDER)_API_KEY\b|your_provider_key\b|<)[^\s'"]{16,}/giu,
    /Authorization:\s*Bearer\s+(?!\$SCRINLY_API_KEY\b|sk_live_your_key\b|sk_live_…\b|<)[^\s'"]{16,}/giu,
  ];
  for (const pattern of secretPatterns) {
    if (pattern.test(fenced)) failures.push(`${relative(root, file)} appears to contain a real credential in an example`);
  }
}

const openapiPath = join(root, 'api-reference', 'openapi.json');
const openapi = JSON.parse(await readFile(openapiPath, 'utf8'));
if (openapi.openapi !== '3.1.0') failures.push('OpenAPI document must use version 3.1.0');
if (!openapi.servers?.some(({ url }) => url === 'https://api.scrinly.com')) failures.push('OpenAPI production server is missing');

const expected = new Set([
  'POST /render',
  'GET /render/snapshot',
  'POST /render/snapshot',
  'GET /render/screenshot',
  'POST /render/screenshot',
  'POST /render/batch',
  'POST /render/smart-batch',
  'GET /status/{jobId}',
  'POST /retry/{jobId}',
  'POST /retry-failed',
  'GET /dead-letter-queue',
  'POST /crawl',
  'GET /crawls',
  'GET /crawl/{crawlId}',
  'DELETE /crawl/{crawlId}',
  'GET /crawl/{crawlId}/pages',
  'GET /crawl/{crawlId}/results',
  'POST /render/scheduled',
  'GET /render/scheduled',
  'DELETE /render/scheduled/{id}',
  'POST /render/bulk-scheduled',
  'POST /render/schedule-recurring',
  'GET /usage',
]);

const actual = new Set();
for (const [path, pathItem] of Object.entries(openapi.paths ?? {})) {
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    if (pathItem[method]) actual.add(`${method.toUpperCase()} ${path}`);
  }
}

for (const route of expected) {
  if (!actual.has(route)) failures.push(`OpenAPI is missing ${route}`);
}
for (const route of actual) {
  if (!expected.has(route)) failures.push(`OpenAPI exposes unexpected route ${route}`);
}

const operatorPrefixes = ['/accounts', '/stats', '/admin', '/cache', '/health', '/healthz', '/ready', '/live', '/internal'];
for (const path of Object.keys(openapi.paths ?? {})) {
  if (operatorPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    failures.push(`Operator route appears in OpenAPI: ${path}`);
  }
}

const navigationText = JSON.stringify(JSON.parse(await readFile(join(root, 'docs.json'), 'utf8')).navigation ?? {});
for (const prefix of operatorPrefixes) {
  if (navigationText.includes(prefix)) failures.push(`Operator route appears in navigation: ${prefix}`);
}

for (const page of navigationText.matchAll(/"((?:getting-started|guides|operations|api-reference)\/[a-z0-9-]+|index|changelog)"/gu)) {
  if (page[1] === 'api-reference/endpoints') continue;
  const file = join(root, `${page[1]}.mdx`);
  try {
    if (!(await stat(file)).isFile()) failures.push(`Navigation page is not a file: ${page[1]}`);
  } catch {
    failures.push(`Navigation page is missing: ${page[1]}`);
  }
}

if (failures.length) {
  console.error(`Documentation audit failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Documentation audit passed: ${actual.size} public operations, ${textFiles.length} text files.`);
