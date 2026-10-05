# Pi Desktop branding

The three folded petals represent independent coding agents sharing one workbench.

- `logo.svg`: transparent standalone mark, editable vector source.
- `logo.png`: 1024 × 1024 transparent export for tools that require raster artwork.
- `icon.svg`: app icon source with a warm ivory tile and transparent outer corners.

Colors: terracotta `#C86545`, lake blue `#398DAA`, golden yellow `#E6B34D`, ivory `#F6F1E7`.

App exports are `build/icon.png` (1024 × 1024), `build/icon.ico` (16–256 px),
`build/icon.icns` (16–1024 px), `resources/icon.png` (512 × 512, Electron),
and `src/renderer/public/mobile-icon.png` (512 × 512, mobile manifest and notifications).

When updating the mark, keep the petal paths identical in both SVG sources. Rasterize
at the export sizes with an SVG renderer such as Sharp, preserving transparency.
Generate ICO and ICNS from the 1024 px PNG with Pillow's multi-size export.
The SVGs are the production sources; generated concept previews are not needed to build the app.
