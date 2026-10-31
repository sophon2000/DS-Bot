# Video host package

The current candidate is `ds-bot@0.2.3-vh.4`, targeting exact DSH
`0.2.2-alpha.2.vh.1.local.20261031.1` and Cordis `4.0.6-alpha.1`. It combines
the retained upstream DS Bot `4a7b55069ad300eae8be42a74f31bc170b40ead7`, the
new Host API adaptations, and fork `develop` commit
`21b46e8e861747f3d839726c5f4f11006986b8c6`, including Bot-owned image fallback
and manually dispatched release automation. The plugin archive does not include
or update DSH. Its producer derives the binding from the actual installed Host.

The previous vh.2 archive targets DSH `0.2.1-rc.2.vh.11.local.20261026.1`.
The vh.3 archive introduced the new Host binding before the latest fork image
fallback fix was integrated. Both archives remain unchanged; their qualification
does not transfer to vh.4.

The bundle mounts only `ds-bot`, with update checks disabled. The existing
profile's web search provider is preserved. A new browser starts in Agent mode,
where the host's workspace and conversation UI remain visible. The sidebar's
**DS Bot** button opens Bot mode; a saved mode choice survives reloads. Bot mode
uses DS Bot's own sidebar and conversation UI. Bot sessions retain the upstream
standard preset; selecting a working directory does not grant Video project
permissions.

Image-to-text fallback belongs only to current Bot chat and group-member Sessions.
Ordinary Host Sessions retain the Host's image-capability policy and do not trigger
Bot OCR calls or cache writes when selecting a text-only model.

Install build dependencies with `npm ci` in `ds-bot/`. The existing `.npmrc`
disables peer auto-installation: tests consume an already installed DSH through
`DSH_HARNESS`. For a pnpm installation, set it to the real directory of the
installed `@deepseek-ai/dsh` package. For a source checkout the test resolver
uses the base, web and CLI bundle dependencies; an installed archive uses the
CLI package dependencies. Lint requires an existing oxlint installation; point
`DSH_HARNESS` to that installation for `npm run lint`.

After `npm test`, `npm run lint`, and `node scripts/build-client.mjs --check`
pass, commit the sources and generated `client.js`. Then pack using the exact
pnpm version declared in `host-artifact.json`:

```sh
node scripts/host-package.mjs prepare \
  --host /absolute/installed/dsh/package.json \
  --pnpm-cli /absolute/pnpm/bin/pnpm.cjs \
  --output /absolute/artifacts
```

The command requires a clean Git checkout and refuses to replace an existing
versioned archive or receipt. It records the committed source SHA at build time,
checks the installed DSH family and peers, includes `LICENSE` and `NOTICE`, and
hashes each packed file and the archive. The generated `host-package.json`
contains no machine paths; the adjacent `.tgz.json` receipt also records the
archive SHA-256 and npm SHA-512 integrity. Build dependencies are excluded.

Consumers install the archive through their package manager, pin its integrity,
then call `verifyHostPackage(pluginDirectory, hostManifest)` from
`ds-bot/host-package`. The check rejects version drift and a second copy of a
host peer even when its version matches. A branch name is development input;
normal starts consume the resulting immutable archive, not a source link.

The artifact is reproducible from the same clean commit, fixed pnpm and installed
host packages. The release archive is published separately after integration
tests; a package receipt alone does not certify live-model or UI behavior.

Historical vh.3 source checks on 2026-10-31 used the built master-upgrade checkout:
`build-client --check`, lint, the five host-package tests and all 26 tests in
the four migrated Host API suites passed. The full suite reported 1125 passed,
2 skipped and 3 blocked by this execution environment rejecting local HTTP
listeners (`listen EPERM`); these were the two mock-model tests and the
credential-bearing redirect test. This is source migration evidence, pending
checks against the installed immutable Host archive.

The independent `app/` and its engine, and the default `dev/harness` installation
recipe, still pin official DSH `0.2.1-rc.2`. They are separate consumers and are
not upgraded or qualified by this Video plugin artifact. Test this candidate with
an explicit `DSH_HARNESS` bound to the installed immutable new Host, including the
CLI and Web bundle peers; do not infer new Host coverage from those older defaults.
