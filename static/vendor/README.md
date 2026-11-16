# Browser dependencies

These release files are vendored so the learning app and its visualizations do
not need a CDN connection. The upstream files are unmodified; the original
licenses are included next to them.

| Package | Release | Files | License |
| --- | --- | --- | --- |
| Three.js | 0.170.0 | `build/three.module.js`, `examples/jsm/controls/OrbitControls.js`, `examples/jsm/renderers/CSS2DRenderer.js` | MIT (`three/LICENSE`) |
| Marked | 12.0.2 | `lib/marked.esm.js`, stored at `marked/marked.esm.js` | MIT (`marked/LICENSE.md`) |

Release archives:

- `https://registry.npmjs.org/three/-/three-0.170.0.tgz`
  SHA-256: `4a608a355dcaba72e0e5383cdc814303f5b6060b43c238cdf6932dceb699238d`
- `https://registry.npmjs.org/marked/-/marked-12.0.2.tgz`
  SHA-256: `6cfd2d09c6bce2541558a1547e5f3b9895ed743f0d287536ff2280e318e8a074`

Three.js addons used here import only the `three` module. Browser import-map
entries in `static/index.html` point to this directory.
