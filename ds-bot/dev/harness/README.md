# Default test Host

This helper installs DSH `0.2.2-alpha.2.vh.1.local.20261031.1` and its exact
Cordis/vendor cohort from the controlled fixed-artifact registry. It supplies
the plugin's default unit-test and lint dependencies when `DSH_HARNESS` is not
set. It does not load the retired application `engine/` or a sibling DSH source
checkout.

With the fixed-artifact registry available, install from `ds-bot/`:

```sh
npm run harness -- --registry=http://127.0.0.1:4875 '--@deepseek-ai:registry=http://127.0.0.1:4875'
env -u DSH_HARNESS npm test
```

Keep strict peer resolution: the harness command sets `legacy-peer-deps=false`.
This helper retains its existing no-lock installation policy; the separate
application has a checked-in npm lock. Its `postinstall` applies the canonical
shared DSH3400 pi-ai `1.3.0` and node-pty `1.2.0-beta.15` patches through the
application's scoped Node installer. Its byte-bound policy copy verifies that
both shared entries are covered.
If scripts were disabled, run `npm --prefix dev/harness run patch:host` from
`ds-bot/`. The default test loader verifies the patched byte hashes before
loading DSH; it never changes an external `DSH_HARNESS` installation. Passing
source tests does not qualify an
Electron installer, model provider, or native platform release.
