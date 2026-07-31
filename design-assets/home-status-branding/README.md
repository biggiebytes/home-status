# Home Status branding

The Beacon identity combines three ideas in one graphics-only mark:

- The roof establishes **home**.
- The lower contour resolves into a **protective shield**.
- The three-point line represents **continuous status awareness**, with the illuminated center indicating what needs attention now.

The design intentionally contains no product name, initials, checkmark, lock, or dashboard-like controls. Its geometry and stroke weight are tuned for recognition at 64×64 and 128×128.

## Recommended assets

| Use | Recommended file |
| --- | --- |
| Home Assistant or HACS icon | `png/icons/home-status-icon-dark-256.png` |
| High-density integration icon | `png/icons/home-status-icon-dark-512.png` |
| GitHub or README on a dark background | `svg/home-status-logo-dark.svg` |
| GitHub or README on a light background | `svg/home-status-logo-light.svg` |
| Dark documentation header | `png/banners/home-status-banner-dark-2400x800.png` |
| Light documentation header | `png/banners/home-status-banner-light-2400x800.png` |

## Package structure

```text
svg/
  home-status-icon-dark.svg
  home-status-icon-light.svg
  home-status-logo-dark.svg
  home-status-logo-light.svg
  home-status-banner-dark.svg
  home-status-banner-light.svg

png/
  icons/
    home-status-icon-{dark|light}-{64|128|256|512|1024}.png
  logos/
    home-status-logo-{dark|light}-{800x450|1600x900}.png
  banners/
    home-status-banner-{dark|light}-{1200x400|2400x800}.png
```

## Color system

| Role | Color |
| --- | --- |
| Charcoal navy | `#07101C` |
| Deep blue | `#173E70` |
| Status blue | `#1476F2` |
| Live cyan | `#55DFFF` |
| Cool white | `#F4F9FF` |
| Light surface | `#EAF2FC` |

## Usage rules

- Preserve clear space equal to at least one status-node diameter around the mark.
- Do not add text inside the app icon.
- Do not recolor the status points as a red/yellow/green dashboard strip.
- Do not add a checkmark, lock, Wi-Fi glyph, window grid, or notification count.
- Prefer the dark app icon as the primary integration identity.
- Use the light variant only where the dark tile would lose contrast.
- Keep SVG sources for documentation and future exports; use PNGs where a registry or platform requires raster assets.
