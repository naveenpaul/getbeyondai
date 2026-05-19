// Architecture invariants from gtm_teammates_plan.md (eng review pass-1 + pass-2).
// CI fails on any violation — keeps the seams enforced as the codebase grows.

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'teammates-cannot-import-adapter-code',
      severity: 'error',
      comment:
        'Architecture invariant: teammates speak only in Contact/Draft/Claim/Citation. ' +
        'They never reach into vendor adapter files. See gtm_teammates_plan.md adapter architecture.',
      from: { path: '^apps/api/src/modules/teammates/' },
      to: { path: '^apps/api/src/modules/connectors/adapters/' },
    },
    {
      name: 'adapters-cannot-import-teammate-code',
      severity: 'error',
      comment:
        'Architecture invariant: adapters are quarantined from the intelligence layer. ' +
        'If an adapter needs a teammate primitive, lift it into packages/shared first.',
      from: { path: '^apps/api/src/modules/connectors/adapters/' },
      to: { path: '^apps/api/src/modules/teammates/' },
    },
    {
      name: 'vendor-sdks-only-in-adapter-files',
      severity: 'error',
      comment:
        'Architecture invariant: vendor SDKs (@hubspot/api-client, jsforce, etc.) only inside the ' +
        'matching adapter file. Lift any shared logic into packages/shared/connector-contracts.',
      from: { pathNot: '^apps/api/src/modules/connectors/adapters/' },
      to: {
        path: '^(@hubspot/|jsforce|node-zoominfo)',
      },
    },
    {
      name: 'anthropic-sdk-only-in-runtime',
      severity: 'error',
      comment:
        'Architecture invariant #3: every LLM call routes through callModel(). ' +
        'The Anthropic SDK should live only in apps/api/src/modules/teammates/runtime/. ' +
        'If a teammate or feature needs to drive Claude differently, extend callModel ' +
        'rather than importing the SDK directly.',
      from: {
        pathNot: '^apps/api/src/modules/teammates/runtime/',
      },
      to: { path: '^@anthropic-ai/sdk' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Files that nothing imports. Either delete or wire up.',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$',
          '\\.d\\.ts$',
          '(^|/)tsconfig\\.json$',
          '(^|/)(babel|webpack)\\.config\\.(js|cjs|mjs|ts|json)$',
          '(^|/)vitest\\.config\\.ts$',
          '(^|/)vitest\\.integration\\.config\\.ts$',
          '(^|/)vite\\.config\\.ts$',
          'main\\.ts$',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: {
      // Build outputs + coverage artifacts. These shouldn't be in the repo but
      // they do appear locally; depcruise reports them as orphans otherwise.
      path: '(^|/)(coverage|dist|build|\\.next|\\.turbo)(/|$)',
    },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    reporterOptions: {
      dot: { collapsePattern: 'node_modules/[^/]+' },
    },
  },
};
