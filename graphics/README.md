# Graphics Templates

This directory contains Lottie animation templates used by the **Reframe + Graphics** pipeline. Templates are exported from Adobe After Effects using the Bodymovin plugin and rendered server-side (Puppeteer + lottie-web) as alpha-channel overlays that are composited onto reframed video via MediaConvert.

## Structure

```
graphics/
  reframe-graphics-overlay-template.aep      ← After Effects source (start here)
  assets/
    logo_placeholder_1000x400.png            ← neutral logo stand-in
  templates/
    graphics-overlay-1080x1920-9x16.json     ← reference template, 9:16
    graphics-overlay-1080x1080-1x1.json      ← reference template, 1:1
    graphics-overlay-1080x1350-4x5.json      ← reference template, 4:5
    {name}-{width}x{height}-{aspect}.json    ← your own templates
```

Only `templates/` is uploaded to S3 on deploy. The `.aep` and `assets/` are
authoring material and deliberately sit outside it.

### Reference template

The three `graphics-overlay-*` files are a working, customer-agnostic template
committed as a starting point: an openly licensed font (Roboto), a neutral logo
placeholder, and no brand assets. They are the only templates tracked in git —
`.gitignore` excludes `graphics/templates/*.json` with a negation for
`graphics-overlay-*`, because customer templates embed station logos and
licensed font outlines.

Use them to verify the pipeline end to end before building anything bespoke: a
fresh clone plus `cdk deploy` produces a deployment that can render an overlay.

Naming convention: `{template-name}-{width}x{height}-{w}x{h}.json`
(e.g. `graphics-overlay-1080x1920-9x16.json`). The Step Functions execution input maps each aspect ratio to a template key, so any naming works as long as it's consistent.

Use `9x16` rather than `9:16` in filenames. Colons are illegal in Windows filenames, and these files get shared with customers who may be on Windows. Some existing templates still use colons for historical reasons.

## Deployment

Templates in this directory are uploaded to the `{prefix}-lottie-templates-{account}-{region}` S3 bucket automatically on every `cdk deploy` (see `LottieTemplatesDeployment` in `lib/infrastructure-stack.ts`). The graphics overlay Lambda downloads the template at render time using the `templateKey` passed in the Step Functions execution input.

> **Note:** `graphics/templates/*.json` is git-ignored. Make sure the template files are present locally before deploying, otherwise the bucket deployment will sync an empty folder.

## Template anatomy

A template is one After Effects project containing **one composition per delivery aspect ratio**, each at final pixel dimensions. Every comp is self-contained: it holds its own copy of the text layers, control nulls and category artwork, and shares only the category sidebar precomps.

```
reframe-graphics-overlay-template.aep
├── graphics-overlay-1080x1920-9x16     ← delivery comp (exported)
├── graphics-overlay-1080x1080-1x1      ← delivery comp (exported)
├── graphics-overlay-1080x1350-4x5      ← delivery comp (exported)
└── sidebar_{category}                  ← shared precomps, one per category
```

Inside each delivery comp, layers fall into three groups.

### Structural — the renderer depends on these

Do not rename or delete. The renderer finds them by name.

| Layer | Type | Role |
|---|---|---|
| `Line 1`, `Line 2`, `Line 3` | text | Headline, one line each |
| `body text` | text | Full headline sentence |
| `Location/Courtesy` | text | Location or source credit |
| Category label | text | Patched with the category name |
| `Line Control` | null | Dropdown for 1/2/3-line layout |
| `breaking line` | shape | Accent rule, recoloured per category |
| `*-TextBox` | shape | Label backgrounds, recoloured per category |
| `logo_placeholder` | precomp | Fixed-size container holding the station logo |

### Optional — per-category artwork variants

Some templates carry a full set of per-category artwork, selected at render time
by a dropdown. This is optional: `set_category_dropdown()` logs a warning and
continues when the control layer is absent, and category colour is applied to
the accent shapes regardless.

| Layer | Type | Role |
|---|---|---|
| `sidebar control` | null | Dropdown selecting the visible category variant |
| `sidebar_{category}` | precomp | One per category, visibility driven by the dropdown |
| `{Category} Gradient` | shape | One per category, colour fade behind the variant artwork |

Category-specific artwork tends to be the most brand-bound part of a template
and the most work to rebrand. If you are building a template for a new
customer, start without it: the accent-colour recolouring in
`CATEGORY_COLORS` already differentiates categories.

### Placeholder — expected to be replaced per customer

| Layer | Replace with |
|---|---|
| `logo_placeholder` (precomp) | Your logo — see below |
| Category label text | Your own category taxonomy |
| Accent and label-background fill colours | Your brand palette (mirror it in `CATEGORY_COLORS`) |
| Placeholder copy (`line 1`, Lorem ipsum) | Nothing — the renderer overwrites it. Keep it representative of real headline lengths so the layout is testable in AE |

#### Replacing the logo

The logo lives in a **fixed-size precomp** (`logo_placeholder`, 1000×400) placed
as a layer in each delivery comp, so the logo is a single point of replacement
rather than three.

**On first open, After Effects will report the logo as missing footage** — the
committed project references it by a path from the machine it was authored on.
That prompt is the easiest moment to bring in your own artwork: point the relink
straight at **your logo** instead of the placeholder. Use
`assets/logo_placeholder_1000x400.png` only if you want to see the template
render before doing any branding work.

After relinking, open the `logo_placeholder` comp and scale the layer to fit
inside the 1000×400 frame. Nothing else needs adjusting: because the precomp's
dimensions never change, the transforms in all three delivery comps stay valid
whatever your logo's pixel dimensions are.

That indirection is the point. Layer scale in After Effects is a percentage of
the source's pixel dimensions, so logo footage placed directly in the delivery
comps would render at the wrong size in every comp the moment it was swapped for
a differently sized file.

### Glyph specimens — keep, do not delete

Each comp contains hidden text layers whose content is the full character set:

```
ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz1234567890 !"#$%&?,;'()-.:/
```

One per font weight used in the comp. Bodymovin only bakes glyph outlines for characters that actually appear in the project, so without these layers a headline containing an unused character renders as a blank space. They are positioned off-canvas or at zero opacity and never appear in output.

If you add a font weight, add a matching specimen layer in that weight. If you support non-ASCII copy (accents, non-Latin scripts), extend the specimen strings to cover those characters.

### Layer naming rules

- **No leading or trailing whitespace.** The renderer compares some names exactly, so `'BREAKING NEWS '` silently fails to match `'BREAKING NEWS'`. `scripts/ae-audit-project.jsx` flags this as a FAIL.
- Keep names stable across aspect ratios. The same layer should have the same name in all three comps.
- Avoid renaming structural layers to something more descriptive — the name *is* the interface.

## Template requirements

The overlay renderer patches the template at render time by **layer name**. For a template to work with the pipeline out of the box, use these layer names in your After Effects project (or adjust the mappings in `lambda/graphics-overlay-handler/index.py`):

### Dynamic text layers

| Layer name          | Content patched at render time            | Max length |
|---------------------|-------------------------------------------|------------|
| `Line 1`            | Headline kicker line 1, uppercase          | 12 chars   |
| `Line 2`            | Kicker line 2 (optional)                   | 12 chars   |
| `Line 3`            | Kicker line 3 (optional)                   | 12 chars   |
| `Category Label`    | Category name (e.g. SPORTS, WEATHER)       | 13 chars   |
| `Location/Courtesy` | Location / source credit, uppercase — layer is hidden when empty | 30 chars |
| `body text`         | Full headline sentence (optional)          | 80 chars   |

These limits are **enforced in code**, not conventions:
`lambda/classify-category-handler/index.js` truncates every field before the
render step, with the comment "hard limits based on Lottie text box sizes". The
13-character figure for the category label is the longest key in
`CATEGORY_COLORS` (`BREAKING NEWS`, `ENTERTAINMENT`, `NATIONAL NEWS`).

Label backgrounds are resized to fit at render time — see
[Text background fitting](#text-background-fitting) below. Author them at a
natural size around your placeholder copy; the handler measures the real string
and adjusts.

### Control layers (null layers with dropdown effects)

| Layer name        | Effect name                     | Purpose                                        | Required |
|-------------------|---------------------------------|------------------------------------------------|----------|
| `Line Control`    | `Number of Lines in Headline`   | Positions the text block for 1, 2, or 3 lines  | recommended |
| `sidebar control` | `Choose News Type` (dropdown)   | Selects which category variant is visible      | only with per-category artwork |

Both are optional in the sense that the renderer warns and continues when they
are absent. Dropdown values are evaluated by lottie-web at render time, so the
expressions driving layer visibility from these controls do survive the export.

### Color-patched shape layers

Shape layers whose names contain `breaking line` or `TextBox` get their fill color replaced with the category accent color at render time. Category names, dropdown indexes, and accent colors are configuration in `lambda/graphics-overlay-handler/index.py` (`CATEGORY_DROPDOWN`, `CATEGORY_ALIASES`, `CATEGORY_COLORS`) — update them to match your station's branding.

### Embedded assets

- **Logos / images:** embed as base64 in the JSON (Bodymovin: Assets → *Include in json*). The renderer runs headless with no external asset access.
- **Fonts:** export with **Glyphs enabled** so text is baked as vector outlines in the `chars` array. No font installation is required at render time, and it is also what makes [text background fitting](#text-background-fitting) possible.

### Bodymovin export settings that matter

| Setting | Value | Why |
|---|---|---|
| Glyphs | **on** | Bakes vector outlines and populates `chars`, which the width measurement reads |
| Assets → Include in json | **on** | Base64-embeds images; the Lambda cannot fetch external files |
| Assets → Enable compression | **off** | Re-encoding can drop the alpha channel, and the overlay composites over video |
| Extra Comps | **off** | Only needed when expressions reference comps outside the layer tree. Leaving it on can embed every delivery comp in every JSON |
| Expression options → convert expressions to keyframes | **off** | Would freeze the `Line Control` dropdown behaviour at export time |
| Use composition names as ids | **on** | Avoids the numeric/named duplicate-asset problem that `fix_lottie_assets()` works around |
| Metadata → include project filename | **off** | Would stamp the source .aep filename into the JSON |
| Export mode | Standard | Demo and Banner modes wrap the JSON in HTML |

## Text background fitting

Label backgrounds are resized **at render time** to fit the string that was
patched into them, by `fit_text_backgrounds()` in
`lambda/graphics-overlay-handler/index.py`.

This exists because auto-sizing cannot work in the template. After Effects rigs
size a background by measuring the text layer with `sourceRectAtTime()`, which
lottie-web does not implement — the expression fails at render time and the box
falls back to whatever static value Bodymovin exported, often a stub a few dozen
pixels wide. Since the handler already rewrites the text, it resizes the
background in the same pass.

How it works:

1. Glyph advance widths are read from the exported `chars` array, so the string
   is measured properly rather than estimated. Width is
   `Σ(glyph.w × fontSize / 100)` plus tracking.
2. Padding is derived per box as `exported_box_width − measured_placeholder_text`,
   so each template keeps its own design spacing with no configuration. If that
   yields an implausible number — usually because the auto-size expression was
   captured mid-animation — it falls back to `DEFAULT_BOX_PADDING_X`.
3. The new width is applied to every rectangle on the layer, and each
   rectangle's position shifts by half the delta so the **left edge stays put**.
4. Any expression on the patched properties is removed, so lottie-web uses the
   value rather than re-evaluating a broken expression over the top of it.

### What the template must provide

| Requirement | Why |
|---|---|
| Box layer named `{Text Layer}-TextBox` | This pairing is how the handler finds the background for a text layer |
| **Glyphs enabled** on export | Measurement reads `chars`. A character missing from it is skipped and the box comes out too narrow — the handler logs which characters were missing |
| Text left-aligned (`j: 0`) | The box grows rightward from a fixed left edge |
| No keyframes on the rectangle's Size or Position | Static geometry is what gets patched |

Because the fit happens per render, **do not size boxes for the longest possible
string**. Author them at a natural size around representative placeholder copy;
`SPORTS` gets a narrow box and `ENTERTAINMENT` a wide one from the same template.

The `Line 1`–`Line 3` and `body text` layers have no background and are not
fitted — their lengths are capped upstream instead.

## Render duration and looping

The overlay is **not** rendered for the full length of the composition. The Step Functions definition passes `maxFrames` to the handler (currently `450`, i.e. 15s at 29.97fps), and MediaConvert composites the result with `Playback: REPEAT`, looping it to cover the whole video.

Two consequences for how you author the animation:

- **Put the entrance animation in the first second or two, then hold.** Only the frames up to `maxFrames` are ever rasterised, so animation beyond that point is invisible. A comp can be any length; the timeline past the cap is simply unused.
- **The overlay restarts every `maxFrames`.** Because the graphic is fully on-screen at the cut point and absent at frame 0, each loop replays the entrance. If you need a graphic to hold without re-animating, raise `maxFrames` to cover the clip. If you want the loop to be invisible, the graphic must be fully present at frame 0 and any motion must complete a whole cycle by the cut.

Render cost scales linearly with frame count: every frame is rasterised individually through Puppeteer before being piped to FFmpeg, and `index.py` puts a 600s timeout on that subprocess inside a 15-minute Lambda.

## Known Lottie / lottie-web limitations

The renderer automatically works around these common Bodymovin export issues, but avoiding them in the AE project gives the most predictable results:

- **Luma track mattes on gradients** don't survive the Lottie export — they render as opaque white-to-black rectangles. The renderer replaces them with a color + alpha fade, but a straight gradient fill with alpha in AE avoids the issue entirely.
- **`sourceRectAtTime()` expressions** (commonly used for auto-sizing text boxes) are not supported by lottie-web, so any geometry derived from text bounds is wrong at render time. Bake such expressions to static values before export — `scripts/ae-sanitize-template.jsx` does this — and let [text background fitting](#text-background-fitting) size the box server-side instead.
- **Track mattes** render only when the matte source has no unsupported expressions, and `_hide_matte_layers()` currently strips every matte as a legacy workaround. Use an animated **mask** for reveals, or a Scale animation on a left-anchored layer, rather than a track matte.
- **Expressions referencing a third-party pseudo-effect** (`effect("Text Box")(...)` and similar) fail at render time even though they are valid AE: Bodymovin does not export pseudo-effects. Bake them.
- **Do not enable Bodymovin's "convert expressions to keyframes"**. It freezes the `Line Control` dropdown behaviour at export time, so every headline renders with whatever line count was set in AE.
- **Duplicate asset IDs**: Bodymovin sometimes exports each precomp twice (numeric + named ID). The renderer deduplicates these automatically.
- Keep effects to those supported by Lottie (transform, opacity, fill, dropdown expression controls). Layer styles, blending modes beyond normal, and third-party effects generally do not export.

## Auditing a template

Two After Effects scripts in `scripts/` support this workflow. Run them via
**File > Scripts > Run Script File...** with the project open, after enabling
**Preferences > Scripting & Expressions > "Allow Scripts to Write Files and Access Network"**.

**`ae-audit-project.jsx`** — read-only. Writes a report covering the comp inventory, every text layer with its PostScript font, footage paths, unused items, expressions unsupported by lottie-web, track mattes, shy and disabled layers, a brand-string scan, and whether the structural layer names above are present. Select your delivery comps in the Project panel first and it audits only those plus their nested precomps.

**`ae-sanitize-template.jsx`** — mutating, dry-run by default. Reduces the project to the delivery comps, deletes guide and disabled layers, clears shy flags, trims whitespace from layer names, remaps fonts from a table, swaps logo footage for a placeholder, and renames comps. Set `DRY_RUN = false` only after reviewing the dry-run report, and work on a copy.

Findings are graded FAIL (breaks the export or the render), LEAK (customer identifier), LICENCE (proprietary font or stock asset whose outlines would be baked into the export), and WARN.

## Creating a template for a new customer or station

Start from `reframe-graphics-overlay-template.aep` rather than a blank project —
it already satisfies the layer-name contract, the control-layer wiring and the
export constraints, which is most of the work.

1. **Open the .aep** and relink the missing logo footage to your own logo
   (see [Replacing the logo](#replacing-the-logo))
2. **Rebrand**: your typeface, your palette on the accent shapes and label
   backgrounds, your layout. Keep the structural layer names exactly as they are
3. **Update `lambda/graphics-overlay-handler/index.py`** if your category
   taxonomy or brand colours differ — `CATEGORY_DROPDOWN`, `CATEGORY_ALIASES`,
   `CATEGORY_COLORS`
4. **Run `scripts/ae-audit-project.jsx`** and resolve any FAIL, LEAK or LICENCE
   findings. A licensed typeface will show as LICENCE: its outlines get baked
   into the JSON by the Glyphs export
5. **Export with Bodymovin** using the settings in
   [Bodymovin export settings that matter](#bodymovin-export-settings-that-matter)
6. **Name the files** following the convention and place them in
   `graphics/templates/`
7. **Deploy** (`npx cdk deploy`) — templates upload to S3 automatically
8. **Pass the template key** per aspect ratio in the `lottieTemplates` map of the
   Step Functions execution input

If you change a structural layer name, change the matching string in
`index.py` too. The name *is* the interface between the template and the
renderer.

## Preparing a template for external sharing

When a template is going to a customer or into a public sample repo, the same
work applies plus a licensing pass:

1. **Reduce to the delivery comps** — a station toolkit typically carries dozens of unrelated comps
2. **Replace station logos** with a neutral placeholder at the same dimensions
3. **Replace licensed fonts** with an openly licensed family (Roboto, Inter, Noto Sans). Glyph export bakes vector outlines of the letterforms into the JSON, so a commercial font travels with the file
4. **Remove stock imagery** (Adobe Stock, Getty, Shutterstock). Standard stock licences do not permit redistribution inside a reusable template
5. **Remove editorial franchise branding** — segment and franchise logos carry no callsign, so keyword scans miss them
6. **Replace brand colours** with a neutral palette
7. **Collect Files to a clean folder** — absolute footage paths embed the machine username and the original project name
8. **Re-run the audit** and confirm zero FAIL, LEAK and LICENCE findings before sending
