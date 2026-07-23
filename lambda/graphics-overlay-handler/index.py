"""
Graphics Overlay Handler

Renders a Lottie animation template as a QuickTime MOV with alpha channel
for use as a MediaConvert MotionImageInserter overlay.

Pipeline:
  1. Load Lottie template JSON from S3
  2. Fix asset deduplication (Bodymovin exports numeric + named comp IDs)
  3. Fix font paths (add fPath/fOrigin so lottie-web DOMLoaded fires)
  4. Set category dropdown on 'sidebar control' layer
  5. Patch text layers (headline lines, category label, location, body text)
  6. Patch color fills (category accent color)
  7. Render frames via Puppeteer + lottie-web → FFmpeg → qtrle MOV with alpha
  8. Upload MOV to S3, return the S3 URI

Template: IG-Story-1080x1920-9:16.json
  - Single JSON handles all categories via 'sidebar control' dropdown
  - Already 1080x1920 — no sub-comp extraction needed
  - Dropdown values: 1=local-news, 2=breaking-news, 3=entertainment,
                     4=national, 5=politics, 6=sports, 7=worldnews, 8=weather
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
                if nm == 'Line 1':
                    doc['t'] = line1
                elif nm == 'Line 2':
                    doc['t'] = line2
                elif nm == 'Line 3':
                    doc['t'] = line3
                elif nm == 'BREAKING NEWS' and 'TextBox' not in nm:
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

        # Step 5: Patch text layers and color fills
        logger.info(
            f"Patching text: line1={line1!r}, line2={line2!r}, line3={line3!r}, "
            f"location={location!r}, headline={headline!r}"
        )
        patch_lottie(lottie_data, category, line1, line2, line3, location, headline)

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
