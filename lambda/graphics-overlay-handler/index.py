"""
Graphics Overlay Handler

Renders a Lottie animation template as a QuickTime MOV with alpha channel
for use as a MediaConvert MotionImageInserter overlay.

Pipeline:
  1. Load Lottie template JSON from S3
  2. Fix asset deduplication (Bodymovin exports numeric + named comp IDs)
  3. Fix font paths (add fPath/fOrigin so lottie-web DOMLoaded fires)
  4. Patch text layers (headline lines, category label, location, body text)
  5. Resize text background boxes to fit the patched text (fit_text_backgrounds)
  6. Render frames via Puppeteer + lottie-web → FFmpeg → qtrle MOV with alpha
  7. Upload MOV to S3, return the S3 URI

Templates: one Lottie JSON per aspect ratio, in the LOTTIE_TEMPLATES_BUCKET
under templates/ —
  - graphics-overlay-1080x1920-9x16.json   (9:16)
  - graphics-overlay-1080x1080-1x1.json    (1:1)
  - graphics-overlay-1080x1350-4x5.json    (4:5)

Each JSON is already at its target resolution, so no sub-comp extraction is
needed. Text boxes are fixed-size in the template and resized at render time
to fit the supplied strings, because lottie-web has no sourceRectAtTime.

Note: set_category_dropdown() and fix_lottie_gradients() support optional
branded layers ('sidebar control' null with a category dropdown, per-category
gradient fills). The reference template ships without those layers, so both
steps log a warning and no-op. They are retained for templates that add them.
"""

import json
import logging
import os
import subprocess
import tempfile

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

s3_client = boto3.client('s3')

# ---------------------------------------------------------------------------
# Category → dropdown index mapping
# Matches the 'Choose News Type' effect on the 'sidebar control' null layer
# ---------------------------------------------------------------------------

CATEGORY_DROPDOWN = {
    'LOCAL NEWS':        1,
    'BREAKING NEWS':     2,
    'ENTERTAINMENT':     3,
    'NATIONAL NEWS':     4,
    'POLITICS':          5,
    'SPORTS':            6,
    'WORLD NEWS':        7,
    'WEATHER':           8,
}

# Aliases for common variations
CATEGORY_ALIASES = {
    'ENTERTAINMENT / LIFESTYLE': 'ENTERTAINMENT',
    'NEWS & POLITICS':           'POLITICS',
    'BUSINESS & FINANCE':        'NATIONAL NEWS',
    'EDUCATION':                 'NATIONAL NEWS',
    'LOCAL LIVING':              'LOCAL NEWS',
    'OFFBEAT':                   'LOCAL NEWS',
    'SCIENCE & TECHNOLOGY':      'NATIONAL NEWS',
    'UNREAL & UNEXPECTED':       'NATIONAL NEWS',
    'NATIONAL':                  'NATIONAL NEWS',
    'WORLDNEWS':                 'WORLD NEWS',
    'WORLD':                     'WORLD NEWS',
    'LOCAL':                     'LOCAL NEWS',
    'BREAKING':                  'BREAKING NEWS',
}

# Category → accent color (hex)
CATEGORY_COLORS = {
    'LOCAL NEWS':        '#EFA192',
    'BREAKING NEWS':     '#DC0101',
    'ENTERTAINMENT':     '#764BD9',
    'NATIONAL NEWS':     '#06569D',
    'POLITICS':          '#4A4A4A',
    'SPORTS':            '#000000',
    'WORLD NEWS':        '#4A4A4A',
    'WEATHER':           '#9C86A7',
}

DEFAULT_CATEGORY = 'BREAKING NEWS'

# Layer names accepted for the category label — the text layer whose content is
# replaced with the current category. 'BREAKING NEWS' is historical: templates
# derived from the original station project name the layer after the default
# category even though it carries any category. 'Category Label' is the
# preferred name for new templates.
CATEGORY_LABEL_LAYER_NAMES = ('BREAKING NEWS', 'Category Label')

# Fake font origin served by render_lottie.js request interception
FONT_ORIGIN = 'http://lottie.render'


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def normalise_category(raw: str) -> str:
    """Normalise a raw category string to a known CATEGORY_DROPDOWN key."""
    upper = raw.strip().upper()
    if upper in CATEGORY_DROPDOWN:
        return upper
    if upper in CATEGORY_ALIASES:
        return CATEGORY_ALIASES[upper]
    logger.warning(f"Unknown category {raw!r}, defaulting to {DEFAULT_CATEGORY}")
    return DEFAULT_CATEGORY


def hex_to_lottie_color(hex_color: str) -> list:
    """Convert '#RRGGBB' to Lottie float color [r, g, b, 1.0]."""
    h = hex_color.lstrip('#')
    return [int(h[i:i+2], 16) / 255.0 for i in (0, 2, 4)] + [1.0]


def _patch_fill_in_shapes(shapes: list, color: list) -> None:
    """Recursively patch all fill ('fl') items in a shapes array."""
    for shape in shapes:
        ty = shape.get('ty')
        if ty == 'fl':
            shape['c']['k'] = color
        elif ty == 'gr':
            _patch_fill_in_shapes(shape.get('it', []), color)


# ---------------------------------------------------------------------------
# Lottie preprocessing
# ---------------------------------------------------------------------------

def fix_lottie_assets(data: dict) -> None:
    """Fix Bodymovin duplicate asset IDs in-place.

    Bodymovin exports each precomp twice:
      - Numeric ID (e.g. 708) — has w, h, layers
      - Named ID (e.g. 'sidebar_breaking-news - 2min') — missing w, h

    lottie-web uses the named string IDs (from refId in layers) and chokes
    on integer IDs with a configError. So we:
      1. Copy w/h from numeric → named (matched by 'nm' field)
      2. Remove all numeric-ID assets from the array
    """
    assets = data.get('assets', [])

    # Build map: nm → numeric asset (has w/h)
    numeric_by_nm = {}
    for a in assets:
        if isinstance(a.get('id'), int) and 'layers' in a and a.get('nm'):
            numeric_by_nm[a['nm']] = a

    # Copy w/h to named assets
    fixed = 0
    for a in assets:
        if isinstance(a.get('id'), str) and 'layers' in a:
            nm = a.get('nm', '')
            src = numeric_by_nm.get(nm)
            if src:
                if not a.get('w'):
                    a['w'] = src['w']
                if not a.get('h'):
                    a['h'] = src['h']
                if not a.get('layers') and src.get('layers'):
                    a['layers'] = src['layers']
                fixed += 1

    # Remove numeric-ID assets — lottie-web expects string IDs only
    before = len(assets)
    data['assets'] = [a for a in assets if not isinstance(a.get('id'), int)]
    removed = before - len(data['assets'])

    logger.info(f"fix_lottie_assets: fixed {fixed} named assets, removed {removed} numeric duplicates")


def fix_lottie_fonts(data: dict) -> None:
    """Add fPath and fOrigin to all fonts so lottie-web DOMLoaded fires.

    Without fPath, lottie-web tries to load fonts from the page origin and
    waits indefinitely, never firing DOMLoaded. We point all fonts to our
    fake origin where render_lottie.js serves a stub TTF.
    """
    fonts = data.get('fonts', {})
    font_list = fonts.get('list', [])
    for font in font_list:
        if not font.get('fPath'):
            font['fPath'] = f'{FONT_ORIGIN}/fonts/'
        if not font.get('fOrigin'):
            font['fOrigin'] = 'p'  # 'p' = path (not CSS)
    logger.info(f"fix_lottie_fonts: patched {len(font_list)} fonts")


def fix_lottie_gradients(data: dict, category: str) -> None:
    """Fix gradient layers that use white-to-black as a luma matte.

    In After Effects these gradient layers act as luma mattes for colored
    solid layers below them. That matte relationship doesn't export to Lottie,
    so they render as opaque white-to-black rectangles.

    Fix: replace the gradient with the category accent color fading from
    transparent at top to opaque at bottom. For sidebar precomps, use the
    actual fill color already present in the asset.
    """
    # Root-level gradient layer name -> category color mapping
    root_gradient_colors = {
        'Local news Gradient':    hex_to_lottie_color(CATEGORY_COLORS.get('LOCAL NEWS', '#EFA192')),
        'Breaking news Gradient': hex_to_lottie_color(CATEGORY_COLORS.get('BREAKING NEWS', '#DC0101')),
        'Entertainment Gradient': hex_to_lottie_color(CATEGORY_COLORS.get('ENTERTAINMENT', '#764BD9')),
        'National Gradient':      hex_to_lottie_color(CATEGORY_COLORS.get('NATIONAL NEWS', '#06569D')),
        'Politics Gradient':      hex_to_lottie_color(CATEGORY_COLORS.get('POLITICS', '#4A4A4A')),
        'Sports Gradient':        hex_to_lottie_color(CATEGORY_COLORS.get('SPORTS', '#000000')),
        'Worldnews Gradient':     hex_to_lottie_color(CATEGORY_COLORS.get('WORLD NEWS', '#4A4A4A')),
        'Weather Gradient':       hex_to_lottie_color(CATEGORY_COLORS.get('WEATHER', '#9C86A7')),
    }

    def _fix_gradient_item(item, layer, color, alpha_top=0.0, alpha_bottom=1.0):
        """Replace white-to-black luma matte gradient with color + alpha fade."""
        g = item.get('g', {})
        k_data = g.get('k', {})
        k = k_data.get('k', [])
        p = g.get('p', 0)
        if len(k) != p * 4:
            return
        r, g_c, b = color[0], color[1], color[2]
        new_color_stops = []
        new_alpha_stops = []
        for i in range(p):
            pos = k[i * 4]
            # Interpolate alpha from alpha_top to alpha_bottom across stops
            t = float(i) / max(p - 1, 1)
            alpha = alpha_top + t * (alpha_bottom - alpha_top)
            new_color_stops += [pos, r, g_c, b]
            new_alpha_stops += [pos, alpha]
        k_data['k'] = new_color_stops + new_alpha_stops

    def _get_fill_color(layers):
        """Find the first solid fill color in a layer set."""
        for layer in layers:
            for shape in layer.get('shapes', []):
                for item in shape.get('it', []):
                    if item.get('ty') == 'fl':
                        k = item.get('c', {}).get('k', [])
                        if isinstance(k, list) and len(k) >= 3:
                            return k[:4]  # r, g, b, a
        return None

    fixed = 0

    # Fix root-level gradient layers
    for layer in data.get('layers', []):
        nm = layer.get('nm', '').strip()
        color = None
        for key, val in root_gradient_colors.items():
            if nm.startswith(key.strip()):
                color = val
                break
        if color is None:
            continue
        for shape in layer.get('shapes', []):
            for item in shape.get('it', []):
                if item.get('ty') == 'gf':
                    # Main gradient: transparent top → opaque bottom
                    _fix_gradient_item(item, layer, color, alpha_top=0.0, alpha_bottom=1.0)
                    fixed += 1
    # Fix gradient layers inside sidebar precomp assets
    for asset in data.get('assets', []):
        if not isinstance(asset.get('id'), str) or 'sidebar' not in asset.get('id', ''):
            continue
        layers = asset.get('layers', [])
        # Get the fill color from the solid layer in this asset
        fill_color = _get_fill_color(layers)
        if fill_color is None:
            continue
        for layer in layers:
            for shape in layer.get('shapes', []):
                for item in shape.get('it', []):
                    if item.get('ty') == 'gf':
                        # Sidebar gradient: opaque top → transparent bottom
                        # (fades ticker text out at the top of the sidebar)
                        _fix_gradient_item(item, layer, fill_color, alpha_top=1.0, alpha_bottom=0.0)
                        fixed += 1

    logger.info(f"fix_lottie_gradients: fixed {fixed} gradient layers for category {category}")
    """Add fPath and fOrigin to all fonts so lottie-web DOMLoaded fires.

    Without fPath, lottie-web tries to load fonts from the page origin and
    waits indefinitely, never firing DOMLoaded. We point all fonts to our
    fake origin where render_lottie.js serves a stub TTF.
    """
    fonts = data.get('fonts', {})
    font_list = fonts.get('list', [])
    for font in font_list:
        if not font.get('fPath'):
            font['fPath'] = f'{FONT_ORIGIN}/fonts/'
        if not font.get('fOrigin'):
            font['fOrigin'] = 'p'  # 'p' = path (not CSS)
    logger.info(f"fix_lottie_fonts: patched {len(font_list)} fonts")


def set_line_count(data: dict, line1: str, line2: str, line3: str) -> None:
    """Set the 'Number of Lines in Headline' dropdown on the 'Line Control' layer.

    This controls the vertical positioning of the text block so the white
    horizontal bar sits directly below the last populated line.
    Values: 1, 2, or 3.
    """
    count = 1
    if line3.strip():
        count = 3
    elif line2.strip():
        count = 2

    for layer in data.get('layers', []):
        if layer.get('nm') == 'Line Control':
            for effect in layer.get('ef', []):
                if effect.get('nm') == 'Number of Lines in Headline':
                    for sub in effect.get('ef', []):
                        if sub.get('nm') == 'Menu':
                            sub['v']['k'] = count
                            logger.info(f"Set 'Number of Lines in Headline' to {count}")
                            return
    logger.warning("Could not find 'Line Control' / 'Number of Lines in Headline' effect")


def set_category_dropdown(data: dict, category: str) -> None:
    """Set the 'Choose News Type' dropdown on the 'sidebar control' layer.

    The dropdown value selects which sidebar precomp is visible via
    opacity expressions on all sidebar layers.
    """
    dropdown_value = CATEGORY_DROPDOWN.get(category, CATEGORY_DROPDOWN[DEFAULT_CATEGORY])
    for layer in data.get('layers', []):
        if layer.get('nm') == 'sidebar control':
            for effect in layer.get('ef', []):
                if effect.get('nm') == 'Choose News Type':
                    for sub in effect.get('ef', []):
                        if sub.get('nm') == 'Menu':
                            sub['v']['k'] = dropdown_value
                            logger.info(f"Set 'Choose News Type' dropdown to {dropdown_value} ({category})")
                            return
    logger.warning("Could not find 'sidebar control' / 'Choose News Type' effect")


# ---------------------------------------------------------------------------
# Text background fitting
#
# After Effects auto-sizing text box rigs measure the text layer with
# sourceRectAtTime(). lottie-web does not implement that function, so the
# expression fails at render time and the box falls back to whatever static
# value Bodymovin exported — often a stub a few dozen pixels wide.
#
# Since this handler already rewrites the text, it can also resize the
# background to match. Glyph advance widths are available in the exported
# `chars` array, so the string can be measured properly rather than estimated.
# ---------------------------------------------------------------------------

# Fallback horizontal padding (total, both sides) when it cannot be derived
# from the template.
DEFAULT_BOX_PADDING_X = 24.0

# A derived padding outside this range means the template's exported box size
# was not a valid measurement of its placeholder text — usually because the
# auto-size expression was captured mid-animation.
PADDING_SANITY_RANGE = (0.0, 200.0)


def _build_char_index(data: dict) -> dict:
    """Index exported glyphs by (character, font family, font style).

    Bodymovin exports each glyph once with `w` as the advance width at font
    size 100, so the advance at an arbitrary size is `w * size / 100`.
    """
    idx = {}
    for c in data.get('chars', []) or []:
        idx[(c.get('ch'), c.get('fFamily'), c.get('style'))] = c
    return idx


def _font_family_style(data: dict, font_name: str):
    """Map a PostScript font name to the (fFamily, fStyle) used in `chars`."""
    for f in data.get('fonts', {}).get('list', []) or []:
        if f.get('fName') == font_name:
            return f.get('fFamily'), f.get('fStyle')
    return None, None


def measure_text_width(data: dict, char_index: dict, text: str,
                       font_name: str, font_size: float,
                       tracking: float = 0.0) -> float:
    """Measure a string's rendered width in pixels from the exported glyphs.

    Returns 0.0 when the font or its glyphs are not present in the template.
    """
    if not text:
        return 0.0

    family, style = _font_family_style(data, font_name)
    if family is None:
        logger.warning(f"measure_text_width: font {font_name!r} not in template")
        return 0.0

    total = 0.0
    missing = []
    for ch in text:
        c = char_index.get((ch, family, style))
        if c is None:
            missing.append(ch)
            continue
        total += float(c.get('w', 0)) * font_size / 100.0

    # Tracking is expressed in 1/1000 em.
    total += (float(tracking) / 1000.0) * font_size * len(text)

    if missing:
        logger.warning(
            f"measure_text_width: {len(missing)} glyph(s) missing from the "
            f"template for {font_name}: {''.join(sorted(set(missing)))!r}. "
            f"Width will be under-estimated — re-export with Glyphs enabled "
            f"and a character-set specimen layer covering these characters."
        )

    return max(total, 0.0)


def _find_rect_shapes(shapes: list) -> list:
    """Collect every rectangle ('rc') item in a shape layer, at any depth."""
    found = []

    def walk(items):
        for it in items or []:
            ty = it.get('ty')
            if ty == 'rc':
                found.append(it)
            elif ty == 'gr':
                walk(it.get('it'))

    walk(shapes)
    return found


def _static(prop: dict):
    """Read a static property value, ignoring any expression attached to it."""
    if not isinstance(prop, dict):
        return None
    return prop.get('k')


def _set_static(prop: dict, value) -> None:
    """Set a static property value and drop any expression on it.

    The expression must go: lottie-web would otherwise try to evaluate it and
    override the value we just wrote.
    """
    prop['k'] = value
    prop['a'] = 0
    prop.pop('x', None)


def fit_text_backgrounds(data: dict, text_by_layer: dict) -> None:
    """Resize each label background to fit the text that was patched into it.

    Pairing is by name: a shape layer called '{name}-TextBox' is treated as the
    background for the text layer called '{name}'. Matching ignores case and
    surrounding whitespace.

    The box's left edge is preserved: a rectangle is centred on its own
    position, so growing the width by d moves the centre by d/2.

    Horizontal padding is derived per box as
        exported_box_width - measured_width_of_placeholder_text
    which keeps each template's own design spacing without configuration. When
    that yields an implausible number — typically because the auto-size
    expression was captured mid-animation — DEFAULT_BOX_PADDING_X is used.
    """
    char_index = _build_char_index(data)
    if not char_index:
        logger.warning("fit_text_backgrounds: template has no `chars` array; "
                       "cannot measure text. Re-export with Glyphs enabled.")
        return

    layer_sets = [data.get('layers', [])]
    for asset in data.get('assets', []):
        if 'layers' in asset:
            layer_sets.append(asset['layers'])

    fitted = 0

    for layers in layer_sets:
        # index shape layers by normalised name
        boxes = {}
        for layer in layers:
            if layer.get('ty') == 4:
                boxes[layer.get('nm', '').strip().lower()] = layer

        for layer in layers:
            if layer.get('ty') != 5:
                continue

            base = layer.get('nm', '').strip()
            box = boxes.get((base + '-textbox').lower())
            if box is None:
                continue

            try:
                doc = layer['t']['d']['k'][0]['s']
            except (KeyError, IndexError, TypeError):
                continue

            new_text = doc.get('t', '')
            font_name = doc.get('f')
            font_size = float(doc.get('s', 0) or 0)
            tracking = float(doc.get('tr', 0) or 0)
            if not font_name or not font_size:
                continue

            original_text = text_by_layer.get(base)
            rects = _find_rect_shapes(box.get('shapes', []))
            if not rects:
                continue

            new_w = measure_text_width(data, char_index, new_text,
                                       font_name, font_size, tracking)
            if new_w <= 0:
                continue

            # An auto-sizing rig typically leaves several rectangles on the
            # layer — a fill, a stroke, sometimes a line — where only one holds
            # a real measurement and the others mirror it through expressions.
            # Bodymovin exports the mirrored ones at whatever the expression
            # happened to evaluate to on frame 0, which is usually a stub.
            #
            # Pick the widest rectangle without an expression as the reference:
            # that is the one whose exported geometry actually described the
            # placeholder text.
            reference = None
            ref_w = -1.0
            for rect in rects:
                size_prop = rect.get('s')
                if not isinstance(size_prop, dict):
                    continue
                val = _static(size_prop)
                if not (isinstance(val, list) and len(val) >= 2):
                    continue
                has_expr = 'x' in size_prop
                width = float(val[0])
                # prefer expression-free; among those, prefer the widest
                score = (0 if has_expr else 1, width)
                if reference is None or score > (0 if 'x' in reference.get('s', {}) else 1, ref_w):
                    reference = rect
                    ref_w = width
            if reference is None:
                continue

            ref_size = _static(reference['s'])
            ref_w = float(ref_size[0])
            ref_h = float(ref_size[1])

            # Derive this box's padding from its own exported geometry.
            padding = DEFAULT_BOX_PADDING_X
            if original_text:
                old_w = measure_text_width(data, char_index, original_text,
                                           font_name, font_size, tracking)
                if old_w > 0:
                    derived = ref_w - old_w
                    lo, hi = PADDING_SANITY_RANGE
                    if lo <= derived <= hi:
                        padding = derived
                        logger.info(
                            f"fit_text_backgrounds: {base}: padding {padding:.1f}px "
                            f"derived from template (box {ref_w:.1f}px, "
                            f"placeholder text {old_w:.1f}px)"
                        )
                    else:
                        logger.info(
                            f"fit_text_backgrounds: {base}: derived padding "
                            f"{derived:.1f}px out of range, using default "
                            f"{DEFAULT_BOX_PADDING_X}px (reference box "
                            f"{ref_w:.1f}px vs placeholder text {old_w:.1f}px)"
                        )

            target_w = new_w + padding

            # Growing the width by d moves a centred rectangle's centre by d/2,
            # which keeps its left edge fixed. Apply the same size and shift to
            # every rectangle so fill and stroke stay aligned.
            shift = (target_w - ref_w) / 2.0

            for rect in rects:
                size_prop = rect.get('s')
                pos_prop = rect.get('p')
                if not isinstance(size_prop, dict):
                    continue

                _set_static(size_prop, [target_w, ref_h])

                if isinstance(pos_prop, dict):
                    old_pos = _static(pos_prop)
                    if isinstance(old_pos, list) and len(old_pos) >= 2:
                        _set_static(pos_prop,
                                    [float(old_pos[0]) + shift, float(old_pos[1])])

            # The layer position may also carry a failed auto-size expression.
            try:
                _set_static(box['ks']['p'], _static(box['ks']['p']))
            except (KeyError, TypeError):
                pass

            fitted += 1
            logger.info(
                f"fit_text_backgrounds: {base}-TextBox -> {target_w:.1f}px "
                f"(text {new_w:.1f}px + padding {padding:.1f}px) for {new_text!r}"
            )

    logger.info(f"fit_text_backgrounds: resized {fitted} background(s)")


def collect_placeholder_text(data: dict) -> dict:
    """Snapshot each text layer's placeholder content, keyed by layer name.

    Must be called BEFORE patch_lottie, so fit_text_backgrounds can derive each
    box's design padding from the text it was originally sized around.
    """
    out = {}
    layer_sets = [data.get('layers', [])]
    for asset in data.get('assets', []):
        if 'layers' in asset:
            layer_sets.append(asset['layers'])

    for layers in layer_sets:
        for layer in layers:
            if layer.get('ty') != 5:
                continue
            try:
                out[layer.get('nm', '').strip()] = layer['t']['d']['k'][0]['s'].get('t', '')
            except (KeyError, IndexError, TypeError):
                continue
    return out


def patch_lottie(data: dict, category: str, line1: str, line2: str,
                 line3: str, location: str, headline: str = '') -> None:
    """Patch text layers and color fills in-place.

    Text layers matched by name (root layers only for this template):
      - 'Line 1', 'Line 2', 'Line 3'  → kicker words
      - 'BREAKING NEWS'                → category label
      - 'Location/Courtesy'            → location / source credit
      - 'body text'                    → full headline sentence

    Shape layers matched by name:
      - 'breaking line'                → accent line (category color)
      - '*-TextBox*'                   → label background boxes (category color)

    If location is empty, all location-related layers are hidden so the
    matte box animation doesn't appear with no text.
    """
    color = hex_to_lottie_color(
        CATEGORY_COLORS.get(category, CATEGORY_COLORS[DEFAULT_CATEGORY])
    )

    # Collect all layer sets: root + every asset comp
    all_layer_sets = [data.get('layers', [])]
    for asset in data.get('assets', []):
        if 'layers' in asset:
            all_layer_sets.append(asset['layers'])

    for layers in all_layer_sets:
        for layer in layers:
            nm = layer.get('nm', '')
            ty = layer.get('ty')

            # Hide all location-related layers if location is empty
            if not location:
                nm_lower = nm.lower()
                if 'location' in nm_lower or 'courtesy' in nm_lower:
                    layer['ks']['o'] = {'a': 0, 'k': 0, 'ix': 11}
                    continue

            if ty == 5:  # text layer
                doc = layer.get('t', {}).get('d', {}).get('k', [{}])[0].get('s', {})
                nm_lower = nm.lower()
                # Normalise for exact-name comparisons: several templates carry
                # trailing spaces on layer names (e.g. 'BREAKING NEWS '), which
                # silently skipped the category-label patch on the 1:1 and 4:5
                # aspect ratios.
                nm_exact = nm.strip()
                if nm_exact == 'Line 1':
                    doc['t'] = line1
                elif nm_exact == 'Line 2':
                    doc['t'] = line2
                elif nm_exact == 'Line 3':
                    doc['t'] = line3
                elif nm_exact in CATEGORY_LABEL_LAYER_NAMES and 'TextBox' not in nm:
                    doc['t'] = category.upper()
                elif 'location' in nm_lower or 'courtesy' in nm_lower:
                    doc['t'] = location
                elif 'body text' in nm_lower and headline:
                    doc['t'] = headline

            elif ty == 4:  # shape layer
                nm_lower = nm.lower()
                if 'breaking line' in nm_lower or 'textbox' in nm_lower:
                    _patch_fill_in_shapes(layer.get('shapes', []), color)


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def _hide_matte_layers(data: dict) -> None:
    """Fix track matte layers for lottie-web SVG renderer.

    lottie-web renders td=1 matte source layers visibly as a side effect.
    Setting opacity to 0 removes the visual artifact.

    For layers where the matte source expression uses sourceRectAtTime()
    (unsupported in lottie-web), the matte stays off-canvas and makes the
    tt=1 target invisible. For these layers we also remove tt=1 so the
    text renders without needing the matte.

    BREAKING NEWS (ind=8) works because its opacity expression drives
    visibility independently. Location/Courtesy (ind=5) has no such
    expression so needs tt=1 removed to be visible.
    """
    all_layer_sets = [data.get('layers', [])]
    for asset in data.get('assets', []):
        if 'layers' in asset:
            all_layer_sets.append(asset['layers'])

    hidden = 0
    unmatted = 0
    for layers in all_layer_sets:
        for layer in layers:
            if layer.get('td') == 1:
                layer['ks']['o'] = {'a': 0, 'k': 0, 'ix': 11}
                hidden += 1
            if layer.get('tt') == 1:
                # Remove tt=1 from all matte targets — the matte source is
                # off-canvas (expression uses unsupported sourceRectAtTime)
                # so the matte never clips correctly. Text visibility is
                # controlled by opacity expressions on the layers themselves.
                del layer['tt']
                unmatted += 1

    logger.info(f"_hide_matte_layers: hid {hidden} matte sources, unmatted {unmatted} targets")


def render_lottie_to_mov(lottie_data: dict, output_path: str,
                         max_frames: int = None) -> dict:
    """Render a Lottie JSON dict to a QuickTime Animation (qtrle) MOV with alpha.

    Uses Puppeteer + lottie-web (SVG renderer) via render_lottie.js subprocess.
    Pipes raw PNG frames through FFmpeg → qtrle MOV.

    Args:
        lottie_data: Preprocessed and patched Lottie JSON dict.
        output_path: Local file path for the output MOV.
        max_frames: Optional cap on frame count (None = full animation).

    Returns:
        dict with frameCount, fps, width, height
    """
    w = lottie_data['w']
    h = lottie_data['h']
    fps = lottie_data['fr']

    with tempfile.TemporaryDirectory() as tmpdir:
        anim_json_path = os.path.join(tmpdir, 'anim.json')
        with open(anim_json_path, 'w') as f:
            json.dump(lottie_data, f)

        script_path = os.path.join(os.path.dirname(__file__), 'render_lottie.js')
        cmd = [
            'node', script_path,
            anim_json_path,
            output_path,
            str(w),
            str(h),
            str(fps),
        ]
        if max_frames is not None:
            cmd.append(str(max_frames))

        logger.info(f"Running: {' '.join(cmd)}")

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=600,  # 10 min max
        )

        if result.stderr:
            logger.info(f"render_lottie.js stderr:\n{result.stderr[-3000:]}")

        if result.returncode != 0:
            raise RuntimeError(
                f"render_lottie.js failed (rc={result.returncode}): {result.stderr[-2000:]}"
            )

        try:
            info = json.loads(result.stdout.strip())
            logger.info(
                f"Rendered {info['frameCount']} frames @ {info['fps']}fps ({w}x{h})"
            )
            return info
        except Exception as e:
            raise RuntimeError(
                f"Failed to parse render_lottie.js output: {result.stdout!r} — {e}"
            )


# ---------------------------------------------------------------------------
# Lambda handler
# ---------------------------------------------------------------------------

def handler(event, context):
    """Render a Lottie graphics overlay as a QuickTime MOV and upload to S3.

    Expected event fields:
      templateBucket   (str)  S3 bucket containing the Lottie template
      templateKey      (str)  S3 key of the Lottie JSON file
      outputBucket     (str)  S3 bucket for the rendered MOV
      itemId           (str)  Mimir item ID — used as the S3 key prefix
      baseFilename     (str)  Base filename from Mimir (without extension)
      aspectRatio      (str)  '9:16' (only 9:16 supported with this template)
      category         (str)  Category name (see CATEGORY_DROPDOWN keys)
      line1            (str)  Headline line 1
      line2            (str)  Headline line 2 (optional, default '')
      line3            (str)  Headline line 3 (optional, default '')
      location         (str)  Location / source credit (optional, default '')
      headline         (str)  Full headline sentence (optional, default '')
      maxFrames        (int)  Optional frame cap (default: full animation)

    Returns:
      overlayS3Uri     (str)  s3://bucket/key of the rendered MOV
      frameCount       (int)  Number of frames rendered
      fps              (float) Frame rate of the overlay
      width            (int)  Pixel width
      height           (int)  Pixel height
      aspectRatio      (str)  Echo of input aspectRatio
      category         (str)  Normalised category used
    """
    logger.info(f"Graphics overlay handler received: {json.dumps(event)}")

    template_bucket = event['templateBucket']
    template_key = event['templateKey']
    output_bucket = event['outputBucket']
    item_id = event['itemId']
    base_filename = event.get('baseFilename', item_id)
    base_filename = os.path.splitext(base_filename)[0]
    aspect_ratio = event.get('aspectRatio', '9:16')
    category = normalise_category(event.get('category', DEFAULT_CATEGORY))
    line1 = event.get('line1', '')
    line2 = event.get('line2', '')
    line3 = event.get('line3', '')
    location = event.get('location', '')
    headline = event.get('headline', '')
    max_frames = event.get('maxFrames', None)

    # S3 key: {itemId}/overlays/{baseFilename}_{aspect}.mov
    aspect_suffix = aspect_ratio.replace(':', '-')
    s3_key = f"{item_id}/overlays/{base_filename}_{aspect_suffix}.mov"

    with tempfile.TemporaryDirectory() as tmpdir:
        # Step 1: Download Lottie template from S3
        template_path = os.path.join(tmpdir, 'template.json')
        logger.info(f"Downloading template: s3://{template_bucket}/{template_key}")
        s3_client.download_file(template_bucket, template_key, template_path)

        with open(template_path) as f:
            lottie_data = json.load(f)

        # Step 2: Fix Bodymovin asset deduplication (named assets missing w/h)
        fix_lottie_assets(lottie_data)

        # Step 3: Fix font paths so lottie-web DOMLoaded fires
        fix_lottie_fonts(lottie_data)

        # Step 4: Fix gradient layers — replace white-to-black with category color fade
        fix_lottie_gradients(lottie_data, category)

        # Step 5: Hide td=1 matte source layers — lottie-web renders them visibly
        # as a side effect but still uses them correctly as matte sources
        _hide_matte_layers(lottie_data)

        # Step 5: Set line count for correct text block positioning
        set_line_count(lottie_data, line1, line2, line3)

        # Step 6: Set category dropdown on 'sidebar control' layer
        logger.info(f"Setting category: {category}")
        set_category_dropdown(lottie_data, category)

        # Step 5: Patch text layers and color fills.
        #
        # Snapshot the placeholder copy first: fit_text_backgrounds derives each
        # label background's design padding from the text it was sized around in
        # After Effects, which is gone once the text has been replaced.
        placeholder_text = collect_placeholder_text(lottie_data)

        logger.info(
            f"Patching text: line1={line1!r}, line2={line2!r}, line3={line3!r}, "
            f"location={location!r}, headline={headline!r}"
        )
        patch_lottie(lottie_data, category, line1, line2, line3, location, headline)

        # Step 5b: Resize label backgrounds to fit the text just patched in.
        # The auto-sizing expressions authored in AE cannot run in lottie-web,
        # so the fit happens here instead.
        fit_text_backgrounds(lottie_data, placeholder_text)

        w = lottie_data['w']
        h = lottie_data['h']
        fps = lottie_data['fr']

        if max_frames is None:
            logger.info("No maxFrames provided — rendering full animation")

        # Step 6: Render → qtrle MOV with alpha
        mov_path = os.path.join(tmpdir, f'{base_filename}_{aspect_suffix}.mov')
        render_info = render_lottie_to_mov(lottie_data, mov_path, max_frames)
        frames_rendered = render_info['frameCount']

        # Step 7: Upload MOV to S3
        logger.info(f"Uploading MOV to s3://{output_bucket}/{s3_key}")
        s3_client.upload_file(
            mov_path,
            output_bucket,
            s3_key,
            ExtraArgs={'ContentType': 'video/quicktime'},
        )

    overlay_uri = f"s3://{output_bucket}/{s3_key}"
    logger.info(
        f"Overlay ready: {overlay_uri} ({frames_rendered} frames, {fps}fps, {w}x{h})"
    )

    return {
        'overlayS3Uri': overlay_uri,
        'frameCount': frames_rendered,
        'fps': fps,
        'width': w,
        'height': h,
        'aspectRatio': aspect_ratio,
        'category': category,
    }
