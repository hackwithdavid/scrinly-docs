# Scrinly API documentation

Public Mintlify documentation for the `browser-cluster-cf` product.

## Local development

```bash
nvm use
npm ci
npm run dev
```

The preview runs at `http://localhost:3000` by default.

## Validation

```bash
npm test
```

This validates Mintlify configuration and OpenAPI, checks internal links and accessibility, and audits the public endpoint and content boundary.

The Worker implementation is the behavioral source of truth. Do not add account provisioning, health, cache-administration, deployment, or platform-admin endpoints to this public site.
