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
const publicTextFiles = textFiles.filter((file) => !file.endsWith('scripts/audit.mjs'));
const publicMdxFiles = publicTextFiles.filter((file) => extname(file) === '.mdx');

const forbiddenPublicContent = [
  { pattern: /boostgpt/iu, label: 'cloned product name' },
  { pattern: /discord\.gg\//iu, label: 'unverified Discord link' },
  { pattern: /designSpec/u, label: 'retired public field' },
  { pattern: /Design Intelligence/iu, label: 'retired feature name' },
  { pattern: /DeepSeek/iu, label: 'removed provider' },
  { pattern: /\bapi_key\b/u, label: 'query API key compatibility' },
  { pattern: /Scrinly SDK/iu, label: 'unsupported SDK claim' },
  { pattern: /\/render\/snapshot\b/u, label: 'internal snapshot route' },
  { pattern: /\/render\/smart-batch\b/u, label: 'internal smart batch route' },
  { pattern: /\/(?:crawl|crawls)(?:\/|\b)/u, label: 'internal crawl route' },
  { pattern: /\/render\/(?:scheduled|bulk-scheduled|schedule-recurring)\b/u, label: 'internal scheduling route' },
  { pattern: /\/(?:retry-failed|dead-letter-queue)\b|\/retry\//u, label: 'internal recovery route' },
];

const secretPatterns = [
  /sk_(?:live|test)_[A-Za-z0-9_-]{20,}/gu,
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /X-Scrinly-Provider-API-Key:\s*(?!\$OPENAI_API_KEY\b|<)[^\s'"]{16,}/giu,
  /Authorization:\s*Bearer\s+(?!\$SCRINLY_API_KEY\b|<)[^\s'"]{16,}/giu,
];

for (const file of publicTextFiles) {
  const content = await readFile(file, 'utf8');
  for (const { pattern, label } of forbiddenPublicContent) {
    if (pattern.test(content)) failures.push(`${relative(root, file)} contains ${label}`);
  }
  const fenced = [...content.matchAll(/```[^\n]*\n([\s\S]*?)```/gu)].map((match) => match[1]).join('\n');
  for (const pattern of secretPatterns) {
    if (pattern.test(fenced)) failures.push(`${relative(root, file)} appears to contain a real credential in an example`);
  }
}

const openapiPath = join(root, 'api-reference', 'openapi.json');
const openapi = JSON.parse(await readFile(openapiPath, 'utf8'));
if (openapi.openapi !== '3.1.0') failures.push('OpenAPI document must use version 3.1.0');
if (openapi.info?.title !== 'Scrinly Browser API') failures.push('OpenAPI title must remain Scrinly Browser API');
if (!openapi.servers?.some(({ url }) => url === 'https://api.scrinly.com')) failures.push('OpenAPI production server is missing');
if (!openapi.components?.securitySchemes?.BearerAuth) failures.push('OpenAPI bearer security scheme is missing');

const expected = new Set([
  'GET /render/screenshot',
  'POST /render/screenshot',
  'POST /render/batch',
  'POST /render/diff',
  'GET /status/{jobId}',
  'GET /usage',
  'GET /render/monitors',
  'POST /render/monitors',
  'GET /render/monitors/{id}',
  'PATCH /render/monitors/{id}',
  'DELETE /render/monitors/{id}',
  'POST /render/monitors/{id}/run',
  'POST /render/monitors/{id}/baseline',
  'GET /render/monitors/{id}/runs',
  'GET /render/monitors/{id}/runs/{runId}',
  'GET /render/monitor-recipients',
  'POST /render/monitor-recipients',
  'GET /render/monitor-recipients/verify',
  'DELETE /render/monitor-recipients/{id}',
]);

const methods = ['get', 'post', 'put', 'patch', 'delete'];
const actual = new Set();
const operations = [];
for (const [path, pathItem] of Object.entries(openapi.paths ?? {})) {
  for (const method of methods) {
    if (!pathItem[method]) continue;
    const route = `${method.toUpperCase()} ${path}`;
    actual.add(route);
    operations.push({ route, path, method, value: pathItem[method] });
  }
}

for (const route of expected) if (!actual.has(route)) failures.push(`OpenAPI is missing ${route}`);
for (const route of actual) if (!expected.has(route)) failures.push(`OpenAPI exposes unexpected route ${route}`);
if (actual.size !== 19) failures.push(`OpenAPI must expose exactly 19 operations, found ${actual.size}`);

const ids = new Map();
for (const operation of operations) {
  const id = operation.value.operationId;
  if (!id) failures.push(`${operation.route} has no operationId`);
  else if (ids.has(id)) failures.push(`Duplicate operationId ${id}: ${ids.get(id)} and ${operation.route}`);
  else ids.set(id, operation.route);
}

function pointer(ref) {
  if (!ref.startsWith('#/')) return null;
  return ref.slice(2).split('/').reduce((value, part) => value?.[part.replaceAll('~1', '/').replaceAll('~0', '~')], openapi);
}

function walk(value, visit, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  visit(value);
  for (const child of Object.values(value)) walk(child, visit, seen);
}

walk(openapi, (value) => {
  if (typeof value.$ref === 'string' && !pointer(value.$ref)) failures.push(`Unresolved OpenAPI reference ${value.$ref}`);
});

function resolvedParameter(parameter) {
  return parameter?.$ref ? pointer(parameter.$ref) : parameter;
}

for (const operation of operations) {
  const inherited = openapi.paths[operation.path]?.parameters ?? [];
  const parameters = [...inherited, ...(operation.value.parameters ?? [])].map(resolvedParameter);
  const hasProviderKey = parameters.some((parameter) => parameter?.in === 'header' && parameter?.name === 'X-Scrinly-Provider-API-Key');
  const screenshot = operation.path === '/render/screenshot';
  if (hasProviderKey !== screenshot) {
    failures.push(`${operation.route} ${hasProviderKey ? 'must not expose' : 'is missing'} X-Scrinly-Provider-API-Key`);
  }
}

const operatorPrefixes = ['/accounts', '/stats', '/admin', '/cache', '/health', '/healthz', '/ready', '/live', '/internal'];
for (const path of Object.keys(openapi.paths ?? {})) {
  if (operatorPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    failures.push(`Operator route appears in OpenAPI: ${path}`);
  }
}

const docs = JSON.parse(await readFile(join(root, 'docs.json'), 'utf8'));
if (docs.theme !== 'almond') failures.push('Mintlify theme must remain almond');
if (docs.name !== 'Scrinly API') failures.push('Mintlify product name must remain Scrinly API');
if (docs.description !== 'Screenshot API for AI agents and automation.') failures.push('Mintlify description is not the approved audience wording');
if (docs.colors?.primary !== '#56C0EF') failures.push('Mintlify primary color changed');

const navigationText = JSON.stringify(docs.navigation ?? {});
for (const prefix of operatorPrefixes) if (navigationText.includes(prefix)) failures.push(`Operator route appears in navigation: ${prefix}`);

for (const page of navigationText.matchAll(/"((?:getting-started|guides|operations|api-reference)\/[a-z0-9-]+|index|changelog)"/gu)) {
  if (page[1] === 'api-reference/endpoints') continue;
  const file = join(root, `${page[1]}.mdx`);
  try {
    if (!(await stat(file)).isFile()) failures.push(`Navigation page is not a file: ${page[1]}`);
  } catch {
    failures.push(`Navigation page is missing: ${page[1]}`);
  }
}

function headingSlug(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/gu, '')
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-');
}

// Mintlify's checker remains the final authority, but local absolute guide
// links should also fail the repository audit when a page or anchor vanishes.
for (const sourceFile of publicMdxFiles) {
  const content = await readFile(sourceFile, 'utf8');
  const destinations = [
    ...content.matchAll(/\]\((\/[a-z0-9\-/#]+)\)/giu),
    ...content.matchAll(/\bhref=["'](\/[a-z0-9\-/#]+)["']/giu),
  ].map((match) => match[1]);

  for (const destination of destinations) {
    const [pathname, anchor] = destination.split('#');
    const page = pathname === '/' ? 'index' : pathname.replace(/^\//u, '').replace(/\/$/u, '');
    const target = join(root, `${page}.mdx`);
    let targetContent;
    try {
      targetContent = await readFile(target, 'utf8');
    } catch {
      failures.push(`${relative(root, sourceFile)} links to missing page ${pathname}`);
      continue;
    }

    if (!anchor) continue;
    const anchors = new Set(
      [...targetContent.matchAll(/^#{2,6}\s+(.+)$/gmu)].map((match) => headingSlug(match[1]))
    );
    if (!anchors.has(anchor)) {
      failures.push(`${relative(root, sourceFile)} links to missing anchor ${destination}`);
    }
  }
}

const obsoletePages = [
  'guides/snapshots.mdx', 'guides/design-extraction.mdx', 'guides/blueprints.mdx',
  'guides/crawling.mdx', 'guides/scheduling.mdx',
];
for (const page of obsoletePages) {
  try {
    await stat(join(root, page));
    failures.push(`Obsolete public guide still exists: ${page}`);
  } catch { /* expected 404 */ }
}

if (failures.length) {
  console.error(`Documentation audit failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Documentation audit passed: ${actual.size} public operations, ${publicTextFiles.length} public text files.`);
