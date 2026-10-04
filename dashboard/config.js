// Public, non-secret defaults for the static Pages dashboard.
// Set relayUrl after deploying the optional Cloudflare Worker described in docs/SETUP.md.
export const HTMLTOAPP_CONFIG = Object.freeze({
  repository: 'tingart/htmltoapp',
  defaultBranch: 'main',
  workflowPath: '.github/workflows/build.yml',
  relayUrl: '',
  maxUploadBytes: 80 * 1024 * 1024,
});
