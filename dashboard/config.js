// Public, non-secret defaults for the static Pages dashboard.
// Direct GitHub Actions is the default; set relayUrl only to opt into the
// optional private Cloudflare relay described in docs/SETUP.md.
export const HTMLTOAPP_CONFIG = Object.freeze({
  repository: 'tingart/htmltoapp',
  defaultBranch: 'main',
  workflowPath: '.github/workflows/build.yml',
  relayUrl: '',
  maxUploadBytes: 80 * 1024 * 1024,
});
