/**
 * ae-sanitize-template.jsx
 *
 * Mutating companion to ae-audit-project.jsx. Automates the mechanical part of
 * turning a customer's broadcast graphics project into a shareable reference
 * template.
 *
 * WHAT IT DOES
 *   1. Optionally lists the PostScript font names installed on this machine
 *   2. Reduces the project to the delivery comps and their dependencies
 *   3. Deletes named comps (safe-zone guides etc.)
 *   4. Deletes layers by name pattern, and all disabled layers
 *   5. Clears the shy flag everywhere
 *   6. Trims leading/trailing whitespace from layer names
 *   7. Remaps fonts from a mapping table
 *   8. Replaces logo footage with a neutral placeholder image
 *   9. Trims comp duration
 *  10. Renames comps
 *  11. Removes unused footage
 *  12. Optionally bakes unsupported expressions to static values
 *
 * WHAT IT DOES NOT DO  (still manual)
 *   - Converting sourceRectAtTime auto-sizing text boxes into fixed-size
 *     rectangles. That is a design decision; see BAKE_UNSUPPORTED_EXPRESSIONS
 *     for a partial automation.
 *   - Swapping brand colours in shape fills.
 *   - File > Dependencies > Collect Files (not exposed to scripting).
 *   - Visual QC. Always render a frame per comp afterwards.
 *
 * USAGE
 *   1. WORK ON A COPY OF THE PROJECT. This script deletes things.
 *   2. Set DRY_RUN = true (the default) and run it. Nothing is modified;
 *      you get a report of every action it would take.
 *   3. Review, edit the CONFIG block, then set DRY_RUN = false and re-run.
 *   4. Everything happens inside one undo group, so Edit > Undo reverts it.
 *   5. Re-run ae-audit-project.jsx to verify.
 *
 * ExtendScript (ES3) — no let/const, arrow functions, or JSON object.
 */

(function aeSanitizeTemplate() {

    // =======================================================================
    // CONFIG
    // =======================================================================

    // Report only. NOTHING is modified while this is true.
    var DRY_RUN = true;

    // Set true to dump the PostScript names of installed fonts and stop.
    // Use this to get exact strings for FONT_MAP — guessing them is the most
    // common reason a font remap silently does nothing.
    var LIST_FONTS_AND_EXIT = false;

    // Comps to keep. Everything not reachable from these is removed.
    // Names must match exactly.
    var DELIVERY_COMPS = [
        'IG-Square-1080x1080-1:1',
        'IG-Story-1080x1920-9:16',
        'Twitter-portrait-1080x1350-4:5'
    ];

    // Comps to delete outright, even though they are referenced.
    // Layers pointing at them are removed first.
    var DELETE_COMPS = [
        'safezone_captions',
        'safezone_instagram-facebook'
    ];

    // Delete any layer whose name contains one of these (case-insensitive).
    var DELETE_LAYERS_MATCHING = [
        'safezone'
    ];

    // Delete layers that are switched off. In this project these are the
    // duplicate '-TextBox 2' layers.
    var DELETE_DISABLED_LAYERS = true;

    // PostScript font name -> PostScript font name.
    // Verify the target names with LIST_FONTS_AND_EXIT first.
    // Verified present on the authoring machine via getFontsByPostScriptName.
    // Roboto-Medium is a closer weight match to Proxima Nova Medium than
    // Roboto-Regular, and costs nothing extra: the export bakes one glyph set
    // per distinct font either way.
    var FONT_MAP = {
        'ProximaNova-Extrabld': 'Roboto-Black',
        'ProximaNova-Bold':     'Roboto-Bold',
        'ProximaNova-Medium':   'Roboto-Medium',
        'ProximaNova-Regular':  'Roboto-Regular',
        'CNNSansDisplay-Heavy': 'Roboto-Black',
        'GTWalsheimAvid-Regular': 'Roboto-Regular'
    };

    // Footage whose name contains one of these is treated as a logo and its
    // source is replaced with a placeholder.
    var LOGO_PATTERNS = ['logo_'];

    // Absolute path to the default placeholder image. Leave '' to skip the
    // whole step.
    //
    // IMPORTANT: FootageItem.replace() swaps the source but keeps the layer's
    // scale, so a placeholder of different pixel dimensions renders at the
    // wrong size. Match dimensions per logo using PLACEHOLDER_BY_SIZE below.
    var PLACEHOLDER_LOGO = '';

    // Pixel dimensions of PLACEHOLDER_LOGO, as 'WIDTHxHEIGHT'. Used only to
    // decide whether to warn about a size mismatch. '' disables the warning.
    // Matches graphics/assets/logo_placeholder.png in this repo.
    var DEFAULT_PLACEHOLDER_DIMS = '6000x4200';

    // Optional: 'WIDTHxHEIGHT' -> absolute path. Checked before
    // PLACEHOLDER_LOGO, so each logo can be swapped for a same-size stand-in.
    // Run once with only PLACEHOLDER_LOGO set to see each item's dimensions in
    // the report, then fill this in.
    var PLACEHOLDER_BY_SIZE = {
        // '500x200': '/absolute/path/logo_placeholder_500x200.png'
    };

    // Footage already named with this prefix is treated as an existing
    // placeholder and skipped, so re-running the script is safe.
    var PLACEHOLDER_NAME_PREFIX = 'logo_placeholder';

    // Trim comps to this many seconds. 0 = leave unchanged (recommended).
    //
    // The pipeline already caps the render at maxFrames (450 = 15s) and loops
    // the overlay with MediaConvert Playback: REPEAT, so a long comp costs
    // nothing at render time. Trimming risks cutting the sidebar ticker's
    // scroll mid-travel, and the result is hard to verify without rendering.
    // Leave at 0 unless you are deliberately redesigning the loop point.
    var TRIM_DURATION_SECONDS = 0;

    // Only trim the comps listed in DELIVERY_COMPS. Leave true: shortening the
    // sidebar ticker precomps can cut their scroll loop mid-travel.
    var TRIM_ONLY_DELIVERY_COMPS = true;

    // Old comp name -> new comp name.
    var RENAME_COMPS = {
        'IG-Square-1080x1080-1:1':        'graphics-overlay-1080x1080-1x1',
        'IG-Story-1080x1920-9:16':        'graphics-overlay-1080x1920-9x16',
        'Twitter-portrait-1080x1350-4:5': 'graphics-overlay-1080x1350-4x5'
    };

    // Replace expressions containing these with their currently evaluated
    // value. Freezes auto-sizing text boxes at their present size, which is
    // what you want for this pipeline: the renderer rewrites the text but not
    // the geometry, so a box that recalculates from text bounds cannot work.
    //
    // Properties with keyframes are skipped, and the value is captured at the
    // CURRENT TIME — park the playhead on a settled frame before running.
    //
    // Worth adding beyond sourceRectAtTime: expressions that reference a
    // third-party pseudo-effect. Bodymovin does not export pseudo-effects, so
    // effect("...") lookups fail at render time even though the expression
    // itself is valid AE. For the common auto-sizing text box rig:
    //
    //   var BAKE_EXPR_MATCHING = ['sourceRectAtTime', 'effect("Text Box")'];
    //
    // Once baked, the pseudo-effect is unreferenced and can be deleted,
    // leaving plain shape layers with static geometry.
    var BAKE_UNSUPPORTED_EXPRESSIONS = false;
    var BAKE_EXPR_MATCHING = ['sourceRectAtTime'];

    // Recursion depth for the bake walk.
    //
    // Must be deep enough to reach shape layer contents. An auto-sizing text
    // box rig puts its geometry expressions at roughly:
    //   Layer > Contents > Text Box > Contents > Fill Group > Contents >
    //   Rectangle Path 1 > Size            (depth 6-7)
    // while the compensating layer Position sits at depth 1. Baking one without
    // the other breaks the animation: the box keeps growing but nothing keeps
    // its left edge pinned, so it expands from the centre in both directions.
    // Freeze the whole rig together, or none of it.
    var MAX_EXPR_DEPTH = 12;

    // =======================================================================
    // Helpers
    // =======================================================================

    var log = [];
    var counts = {};

    function w(s) { log.push(s === undefined ? '' : String(s)); }
    function hr(t) {
        w('');
        w('---- ' + t + ' ' + '------------------------------------------'.substring(0, Math.max(0, 60 - t.length)));
    }
    function act(kind, detail) {
        counts[kind] = (counts[kind] || 0) + 1;
        w('  ' + (DRY_RUN ? '[would] ' : '[done]  ') + kind + ': ' + detail);
    }
    function note(s) { w('  ' + s); }
    function pad(s, n) {
        s = String(s === undefined || s === null ? '' : s);
        while (s.length < n) { s += ' '; }
        return s;
    }
    function lower(s) { return String(s === undefined ? '' : s).toLowerCase(); }
    function trim(s) { return String(s === undefined ? '' : s).replace(/^\s+|\s+$/g, ''); }

    function matchesAny(s, list) {
        var h = lower(s);
        for (var a = 0; a < list.length; a++) {
            if (h.indexOf(lower(list[a])) !== -1) { return true; }
        }
        return false;
    }

    function findItemsByName(names) {
        var found = [];
        for (var a = 1; a <= app.project.numItems; a++) {
            var it = app.project.item(a);
            for (var b = 0; b < names.length; b++) {
                if (it.name === names[b]) { found.push(it); }
            }
        }
        return found;
    }

    function allComps() {
        var acc = [];
        for (var a = 1; a <= app.project.numItems; a++) {
            if (app.project.item(a) instanceof CompItem) { acc.push(app.project.item(a)); }
        }
        return acc;
    }

    // =======================================================================
    // Guards
    // =======================================================================

    if (!app.project) { alert('No project is open.'); return; }
    var proj = app.project;

    w('After Effects Template Sanitizer');
    w('Mode: ' + (DRY_RUN ? 'DRY RUN — nothing will be modified' : '*** APPLYING CHANGES ***'));
    w('Project: ' + (proj.file ? proj.file.name : '(unsaved)'));
    w('Items before: ' + proj.numItems + '  Comps before: ' + allComps().length);

    // ---- 1. Font listing mode ---------------------------------------------

    if (LIST_FONTS_AND_EXIT) {
        hr('INSTALLED FONTS (PostScript names)');

        var printed = 0;
        var seen = {};

        // FontObject property names vary between AE releases. Read whichever
        // of these yields a string.
        var PS_PROPS = ['postScriptName', 'postscriptName', 'psName', 'fullName'];

        function readProp(obj, names) {
            for (var a = 0; a < names.length; a++) {
                try {
                    var v = obj[names[a]];
                    if (v && typeof v === 'string') { return v; }
                } catch (e) {}
            }
            return null;
        }

        function emitFont(f) {
            if (!f) { return; }
            var ps = readProp(f, PS_PROPS);
            if (!ps || seen[ps]) { return; }
            seen[ps] = true;
            var fam = readProp(f, ['familyName', 'nativeFamilyName']) || '';
            var sty = readProp(f, ['styleName', 'nativeStyleName']) || '';
            w('  ' + ps + '   (' + fam + ' / ' + sty + ')');
            printed++;
        }

        var coll = null;
        try { coll = app.fonts.allFonts; } catch (eA) { coll = null; }
        var collLen = 0;
        if (coll) { try { collLen = coll.length || 0; } catch (eL) { collLen = 0; } }

        w('  app.fonts.allFonts length: ' + collLen);

        // Inspect one entry so we can see what a FontObject actually exposes.
        // Try both 0-based and 1-based indexing — AE collections are often 1-based.
        var probe = null, probeIdx = null;
        var tryIdx = [0, 1];
        for (var pi = 0; pi < tryIdx.length; pi++) {
            try {
                var cand = coll[tryIdx[pi]];
                if (cand) { probe = cand; probeIdx = tryIdx[pi]; break; }
            } catch (eP) {}
        }

        if (probe) {
            w('  first readable entry at index ' + probeIdx);
            var pk = [];
            try { for (var k1 in probe) { pk.push(k1); } } catch (eK) {}
            w('  FontObject properties: ' + (pk.length ? pk.join(', ') : '(not enumerable)'));
            w('');
        } else {
            w('  could not read any entry by index — collection is not subscriptable');
            w('');
        }

        // Enumerate, covering both index bases.
        if (collLen) {
            for (var fi = 0; fi <= collLen; fi++) {
                var f0 = null;
                try { f0 = coll[fi]; } catch (eI) { f0 = null; }
                emitFont(f0);
            }
        }

        // Direct existence test for candidate PostScript names. This is the
        // authoritative check: if getFontsByPostScriptName returns something,
        // the string is valid for TextDocument.font.
        w('');
        w('  --- Candidate PostScript name lookups ---');
        var wanted = [
            'Roboto-Black', 'Roboto-Bold', 'Roboto-Medium', 'Roboto-Regular',
            'Roboto-Light',
            'Inter-Black', 'Inter-Bold', 'Inter-Regular',
            'NotoSans-Black', 'NotoSans-Bold', 'NotoSans-Regular',
            'OpenSans-Bold', 'OpenSans-Regular',
            'ArialMT', 'Arial-BoldMT', 'Helvetica', 'Helvetica-Bold',
            'ProximaNova-Extrabld', 'ProximaNova-Bold',
            'ProximaNova-Medium', 'ProximaNova-Regular'
        ];
        var foundByLookup = 0;
        for (var wi = 0; wi < wanted.length; wi++) {
            var res = null, err = '';
            try { res = app.fonts.getFontsByPostScriptName(wanted[wi]); }
            catch (eW) { err = eW.toString(); }
            var n = 0;
            if (res) { try { n = res.length || 0; } catch (eN) { n = 0; } }
            if (n) { foundByLookup++; }
            w('  ' + pad(wanted[wi], 26) +
              (n ? 'FOUND (' + n + ')' : (err ? 'error: ' + err : 'not installed')));
        }
        w('');
        w('  ' + foundByLookup + ' of ' + wanted.length +
          ' candidate name(s) resolved. Use a FOUND name in FONT_MAP.');

        // Verify the FONT_MAP targets actually exist before the real run.
        w('');
        w('  --- FONT_MAP target validation ---');
        var badTargets = 0;
        var srcFont;
        for (srcFont in FONT_MAP) {
            if (!FONT_MAP.hasOwnProperty(srcFont)) { continue; }
            var tgt = FONT_MAP[srcFont];
            var tr = null;
            try { tr = app.fonts.getFontsByPostScriptName(tgt); } catch (eT) {}
            var tn = 0;
            if (tr) { try { tn = tr.length || 0; } catch (eTn) { tn = 0; } }
            if (!tn) { badTargets++; }
            w('  ' + pad(srcFont, 26) + ' -> ' + pad(tgt, 22) +
              (tn ? 'OK' : '*** TARGET NOT INSTALLED — remap would be skipped ***'));
        }
        if (badTargets) {
            w('');
            w('  ' + badTargets + ' FONT_MAP target(s) are not installed. Install them,');
            w('  or change FONT_MAP to a name listed as FOUND above, before');
            w('  running with DRY_RUN = false.');
        }

        // Family + style lookups, using the method this AE version exposes.
        w('');
        w('  --- Family / style lookups ---');
        var fams = [
            ['Roboto', 'Black'], ['Roboto', 'Bold'], ['Roboto', 'Regular'],
            ['Inter', 'Bold'], ['Inter', 'Regular'],
            ['Noto Sans', 'Bold'], ['Noto Sans', 'Regular'],
            ['Proxima Nova', 'Bold']
        ];
        for (var fmi = 0; fmi < fams.length; fmi++) {
            var got = null, gerr = '';
            try {
                got = app.fonts.getFontsByFamilyNameAndStyleName(fams[fmi][0], fams[fmi][1]);
            } catch (eF2) { gerr = eF2.toString(); }
            var gn = 0;
            if (got) { try { gn = got.length || 0; } catch (eG) { gn = 0; } }
            w('  ' + pad(fams[fmi][0] + ' / ' + fams[fmi][1], 26) +
              (gn ? 'FOUND (' + gn + ')' : (gerr ? 'error: ' + gerr : 'not installed')));
            if (gn) {
                for (var gi2 = 0; gi2 <= gn; gi2++) {
                    var gf = null;
                    try { gf = got[gi2]; } catch (eGi) { gf = null; }
                    if (gf) {
                        var gps = readProp(gf, PS_PROPS);
                        if (gps) { w('        -> PostScript: ' + gps); }
                    }
                }
            }
        }

        // What is currently missing or substituted in this project.
        w('');
        w('  --- Missing / substituted fonts in this project ---');
        try {
            var miss = app.fonts.missingOrSubstitutedFonts;
            var mn = 0;
            if (miss) { try { mn = miss.length || 0; } catch (eM) { mn = 0; } }
            if (!mn) {
                w('  (none)');
            } else {
                for (var mi = 0; mi <= mn; mi++) {
                    var mf = null;
                    try { mf = miss[mi]; } catch (eMi) { mf = null; }
                    if (mf) {
                        var mps = readProp(mf, PS_PROPS) || '(unnamed)';
                        var mfam = readProp(mf, ['familyName']) || '';
                        w('  ' + mps + '   (' + mfam + ')');
                    }
                }
            }
        } catch (eMs) {
            w('  could not read missingOrSubstitutedFonts: ' + eMs.toString());
        }

        w('');
        w('  Total unique PostScript names printed: ' + printed);
        if (!printed) {
            w('');
            w('  WORKAROUND: set a text layer to the font you want via the');
            w('  Character panel, then run ae-audit-project.jsx. Section 2 of');
            w('  that report lists the PostScript name of every text layer font.');
        }

        writeReport();
        alert('Font report written.\n\n' +
              foundByLookup + ' of ' + wanted.length + ' candidate name(s) resolved.\n' +
              (badTargets
                 ? badTargets + ' FONT_MAP target(s) NOT installed — fix before applying.'
                 : 'All FONT_MAP targets are installed.') + '\n\n' +
              'Set LIST_FONTS_AND_EXIT = false to continue.');
        return;
    }

    if (!DRY_RUN) {
        var ok = confirm('This will modify the open project.\n\n' +
                         'Have you saved a copy first?\n\n' +
                         'Everything runs in one undo group, but Reduce Project ' +
                         'is aggressive. Continue?');
        if (!ok) { return; }
        app.beginUndoGroup('Sanitize graphics template');
    }

    try {

        // ---- 2. Reduce project to the delivery comps -----------------------
        //
        // This runs FIRST, deliberately. Every later step walks all remaining
        // comps, so reducing up front means the layer deletions, whitespace
        // trims and font remaps only touch comps that ship. Running them first
        // instead sanitises ~150 comps that are about to be deleted, which
        // bloats the undo group and makes the report unreadable.
        //
        // Comps in DELETE_COMPS survive this step because delivery comps still
        // reference them. They are removed explicitly in step 4.

        hr('REDUCE PROJECT');
        var comps;
        var ci, li;
        var keep = findItemsByName(DELIVERY_COMPS);
        if (keep.length !== DELIVERY_COMPS.length) {
            note('WARNING: found ' + keep.length + ' of ' + DELIVERY_COMPS.length +
                 ' delivery comps. Check DELIVERY_COMPS spelling — names must match exactly.');
            for (var kx = 0; kx < keep.length; kx++) { note('  matched: ' + keep[kx].name); }
        }
        if (keep.length) {
            var before = proj.numItems;
            if (DRY_RUN) {
                act('reduce project', 'keep ' + keep.length + ' comp(s), ' +
                    'remove items not reachable from them (currently ' + before + ' items)');
                note('DRY RUN: later steps below still report against all ' +
                     allComps().length + ' comps, because nothing was actually');
                note('removed. On the real run they only touch what survives here.');
            } else {
                var removed = proj.reduceProject(keep);
                act('reduce project', 'removed ' + removed + ' item(s); ' +
                    proj.numItems + ' remain');
            }
        } else {
            note('SKIPPED — no delivery comps matched, refusing to reduce.');
        }

        // ---- 3. Delete layers by name pattern ------------------------------
        // Includes layers whose source is a comp listed in DELETE_COMPS, so
        // those comps become unreferenced before we remove them.

        hr('DELETE LAYERS BY NAME PATTERN');
        comps = allComps();
        for (ci = 0; ci < comps.length; ci++) {
            var comp = comps[ci];
            for (li = comp.numLayers; li >= 1; li--) {   // backwards: we delete
                var lyr = comp.layer(li);
                var hit = matchesAny(lyr.name, DELETE_LAYERS_MATCHING);
                if (!hit) {
                    // also catch layers whose SOURCE is a comp slated for deletion
                    try {
                        var src = lyr.source;
                        if (src && src instanceof CompItem) {
                            for (var dc = 0; dc < DELETE_COMPS.length; dc++) {
                                if (src.name === DELETE_COMPS[dc]) { hit = true; break; }
                            }
                        }
                    } catch (eSrc) {}
                }
                if (hit) {
                    act('delete layer', comp.name + ' / ' + lyr.name);
                    if (!DRY_RUN) { lyr.remove(); }
                }
            }
        }

        // ---- 4. Delete named comps -----------------------------------------

        hr('DELETE COMPS');
        var toDelete = findItemsByName(DELETE_COMPS);
        for (var di = 0; di < toDelete.length; di++) {
            act('delete comp', toDelete[di].name);
            if (!DRY_RUN) { toDelete[di].remove(); }
        }
        if (!toDelete.length) { note('(none found — may already have been removed)'); }

        // ---- 5. Delete disabled layers -------------------------------------

        if (DELETE_DISABLED_LAYERS) {
            hr('DELETE DISABLED LAYERS');
            note('Track matte source layers are skipped: After Effects switches');
            note('a layer OFF when it is assigned as a matte, so "disabled" does');
            note('not mean unused. Deleting them silently breaks the animation');
            note('they drive.');
            comps = allComps();
            for (ci = 0; ci < comps.length; ci++) {
                var c2 = comps[ci];
                for (li = c2.numLayers; li >= 1; li--) {
                    var l2 = c2.layer(li);
                    if (l2.enabled) { continue; }

                    // Is this layer used as a track matte?
                    var isMatte = false;
                    try {
                        if (l2.isTrackMatte) { isMatte = true; }
                    } catch (eTm) {}
                    // Fallback for older AE: a matte source sits directly above
                    // a layer whose trackMatteType is set.
                    if (!isMatte) {
                        try {
                            if (li < c2.numLayers) {
                                var belowT = c2.layer(li + 1).trackMatteType;
                                if (belowT && belowT !== TrackMatteType.NO_TRACK_MATTE) {
                                    isMatte = true;
                                }
                            }
                        } catch (eBelow) {}
                    }

                    if (isMatte) {
                        note('KEPT (track matte source): ' + c2.name + ' / ' + l2.name);
                        continue;
                    }

                    act('delete disabled layer', c2.name + ' / ' + l2.name);
                    if (!DRY_RUN) { l2.remove(); }
                }
            }
        }

        // ---- 6. Un-shy everything ------------------------------------------

        hr('CLEAR SHY FLAGS');
        comps = allComps();
        var shyCleared = 0;
        for (ci = 0; ci < comps.length; ci++) {
            var c3 = comps[ci];
            if (!DRY_RUN) { c3.hideShyLayers = false; }
            for (li = 1; li <= c3.numLayers; li++) {
                if (c3.layer(li).shy) {
                    shyCleared++;
                    if (!DRY_RUN) { c3.layer(li).shy = false; }
                }
            }
        }
        note((DRY_RUN ? 'would clear ' : 'cleared ') + shyCleared + ' shy flag(s)');

        // ---- 7. Trim whitespace in layer names -----------------------------

        hr('TRIM LAYER NAME WHITESPACE');
        comps = allComps();
        for (ci = 0; ci < comps.length; ci++) {
            var c4 = comps[ci];
            for (li = 1; li <= c4.numLayers; li++) {
                var l4 = c4.layer(li);
                var trimmed = trim(l4.name);
                if (trimmed !== l4.name && trimmed.length) {
                    act('trim layer name', c4.name + ' / "' + l4.name + '" -> "' + trimmed + '"');
                    if (!DRY_RUN) { l4.name = trimmed; }
                }
            }
        }

        // ---- 8. Font remap --------------------------------------------------

        hr('FONT REMAP');
        comps = allComps();
        for (ci = 0; ci < comps.length; ci++) {
            var c5 = comps[ci];
            for (li = 1; li <= c5.numLayers; li++) {
                var l5 = c5.layer(li);
                if (!(l5 instanceof TextLayer)) { continue; }
                var prop;
                try { prop = l5.property('Source Text'); } catch (eP) { continue; }
                if (!prop) { continue; }

                if (prop.numKeys > 0) {
                    // keyframed: remap every key
                    for (var ki = 1; ki <= prop.numKeys; ki++) {
                        try {
                            var tdk = prop.keyValue(ki);
                            var mapped = FONT_MAP[tdk.font];
                            if (mapped) {
                                act('remap font (keyframed)', c5.name + ' / ' + l5.name +
                                    '  key ' + ki + '  ' + tdk.font + ' -> ' + mapped);
                                if (!DRY_RUN) {
                                    tdk.font = mapped;
                                    prop.setValueAtKey(ki, tdk);
                                }
                            }
                        } catch (eK) {}
                    }
                } else {
                    try {
                        var td = prop.value;
                        var target = FONT_MAP[td.font];
                        if (target) {
                            act('remap font', c5.name + ' / ' + l5.name +
                                '  ' + td.font + ' -> ' + target);
                            if (!DRY_RUN) {
                                td.font = target;
                                prop.setValue(td);
                            }
                        }
                    } catch (eT) {
                        note('could not read Source Text on ' + c5.name + ' / ' + l5.name);
                    }
                }
            }
        }

        // ---- 9. Replace logo footage with placeholder -----------------------

        hr('REPLACE LOGO FOOTAGE');
        if (!PLACEHOLDER_LOGO) {
            note('SKIPPED — PLACEHOLDER_LOGO is empty. Set it to an absolute path.');
            // still report which items would be targeted
            for (var pi = 1; pi <= proj.numItems; pi++) {
                var pit = proj.item(pi);
                if (pit instanceof FootageItem && matchesAny(pit.name, LOGO_PATTERNS)) {
                    note('  target: ' + pit.name);
                }
            }
        } else {
            var defaultPh = new File(PLACEHOLDER_LOGO);
            if (!defaultPh.exists) {
                note('SKIPPED — placeholder not found: ' + PLACEHOLDER_LOGO);
            } else {
                // Snapshot the targets BEFORE mutating anything.
                // FootageItem.replace() can reorder the project panel, so
                // iterating live indices could visit an item twice (once as the
                // original, again after it was renamed to logo_placeholder_*).
                var logoTargets = [];
                for (var qi = 1; qi <= proj.numItems; qi++) {
                    var qit = proj.item(qi);
                    if (!(qit instanceof FootageItem)) { continue; }
                    if (!matchesAny(qit.name, LOGO_PATTERNS)) { continue; }
                    // already a placeholder — skip so re-runs are idempotent
                    if (lower(qit.name).indexOf(lower(PLACEHOLDER_NAME_PREFIX)) === 0) {
                        note('already a placeholder, skipping: ' + qit.name);
                        continue;
                    }
                    logoTargets.push(qit);
                }

                note('found ' + logoTargets.length + ' logo item(s) to replace');

                for (var lt = 0; lt < logoTargets.length; lt++) {
                    var item = logoTargets[lt];

                    // Pick a placeholder matching this item's pixel dimensions,
                    // so the layer's existing scale still reads correctly.
                    var dims = '';
                    try { dims = item.width + 'x' + item.height; } catch (eDim) { dims = '?'; }

                    var chosen = defaultPh;
                    var usedSized = false;
                    var sized = PLACEHOLDER_BY_SIZE[dims];
                    if (sized) {
                        var sf = new File(sized);
                        if (sf.exists) {
                            chosen = sf;
                            usedSized = true;
                        } else {
                            note('  PLACEHOLDER_BY_SIZE["' + dims + '"] not found: ' + sized);
                        }
                    }

                    // Warn only when we know the default placeholder is a
                    // different size than the source it is replacing.
                    var mismatch = '';
                    if (!usedSized && DEFAULT_PLACEHOLDER_DIMS &&
                        dims !== '?' && dims !== DEFAULT_PLACEHOLDER_DIMS) {
                        mismatch = '   *** SIZE MISMATCH: source ' + dims +
                                   ' vs placeholder ' + DEFAULT_PLACEHOLDER_DIMS +
                                   ' — layer scale will be wrong. Add ' +
                                   'PLACEHOLDER_BY_SIZE["' + dims + '"] ***';
                    }

                    act('replace logo source',
                        item.name + '  (' + dims + ')  -> ' + chosen.name + mismatch);
                    if (!DRY_RUN) {
                        try {
                            item.replace(chosen);
                            item.name = PLACEHOLDER_NAME_PREFIX +
                                        (dims !== '?' ? '_' + dims : '');
                        } catch (eR) {
                            note('  failed: ' + eR.toString());
                        }
                    }
                }
            }
        }

        // ---- 10. Bake unsupported expressions ------------------------------

        if (BAKE_UNSUPPORTED_EXPRESSIONS) {
            hr('BAKE UNSUPPORTED EXPRESSIONS');
            comps = allComps();

            function bakeIn(propGroup, where, depth) {
                if (depth > MAX_EXPR_DEPTH) { return; }
                var n = 0;
                try { n = propGroup.numProperties; } catch (eN) { return; }
                for (var p = 1; p <= n; p++) {
                    var sp;
                    try { sp = propGroup.property(p); } catch (eG) { continue; }
                    if (!sp) { continue; }
                    try {
                        if (sp.canSetExpression && sp.expressionEnabled && sp.expression &&
                            matchesAny(sp.expression, BAKE_EXPR_MATCHING)) {
                            if (sp.numKeys > 0) {
                                note('skipped (keyframed): ' + where + ' -> ' + sp.name);
                            } else {
                                var frozen = sp.value;   // evaluated, expression applied
                                act('bake expression', where + ' -> ' + sp.name);
                                if (!DRY_RUN) {
                                    sp.expression = '';
                                    sp.setValue(frozen);
                                }
                            }
                        }
                    } catch (eE) {}
                    if (sp.numProperties) { bakeIn(sp, where, depth + 1); }
                }
            }

            for (ci = 0; ci < comps.length; ci++) {
                var c6 = comps[ci];
                for (li = 1; li <= c6.numLayers; li++) {
                    bakeIn(c6.layer(li), c6.name + ' / ' + c6.layer(li).name, 0);
                }
            }
        }

        // ---- 11. Trim comp duration ----------------------------------------

        if (TRIM_DURATION_SECONDS > 0) {
            hr('TRIM COMP DURATION');
            comps = allComps();
            for (ci = 0; ci < comps.length; ci++) {
                var c7 = comps[ci];
                if (TRIM_ONLY_DELIVERY_COMPS) {
                    var isDelivery = false;
                    for (var dvi = 0; dvi < DELIVERY_COMPS.length; dvi++) {
                        if (c7.name === DELIVERY_COMPS[dvi]) { isDelivery = true; break; }
                    }
                    if (!isDelivery) { continue; }
                }
                if (c7.duration > TRIM_DURATION_SECONDS) {
                    act('trim duration', c7.name + '  ' +
                        Math.round(c7.duration) + 's -> ' + TRIM_DURATION_SECONDS + 's');
                    if (!DRY_RUN) {
                        try {
                            c7.duration = TRIM_DURATION_SECONDS;
                            c7.workAreaStart = 0;
                            c7.workAreaDuration = TRIM_DURATION_SECONDS;
                        } catch (eD) {
                            note('  failed on ' + c7.name + ': ' + eD.toString());
                        }
                    }
                }
            }
            note('NOTE: trimming does not shorten the scroll animation on ticker');
            note('      layers. Check the sidebar loops still read correctly.');
        }

        // ---- 12. Rename comps ----------------------------------------------

        hr('RENAME COMPS');
        comps = allComps();
        for (ci = 0; ci < comps.length; ci++) {
            var c8 = comps[ci];
            var newName = RENAME_COMPS[c8.name];
            if (newName) {
                act('rename comp', c8.name + ' -> ' + newName);
                if (!DRY_RUN) { c8.name = newName; }
            }
        }

        // ---- 13. Remove unused footage -------------------------------------

        hr('REMOVE UNUSED FOOTAGE');
        if (DRY_RUN) {
            var unusedCount = 0;
            for (var ui = 1; ui <= proj.numItems; ui++) {
                var uit = proj.item(ui);
                if (uit instanceof CompItem) { continue; }
                try {
                    if (uit.usedIn.length === 0) {
                        unusedCount++;
                        note('  unused: ' + uit.name);
                    }
                } catch (eU) {}
            }
            act('remove unused footage', unusedCount + ' item(s)');
        } else {
            var removedUnused = proj.removeUnusedFootage();
            act('remove unused footage', removedUnused + ' item(s) removed');
        }

    } catch (eMain) {
        w('');
        w('*** ABORTED: ' + eMain.toString() +
          (eMain.line ? '  (line ' + eMain.line + ')' : ''));
    }

    if (!DRY_RUN) {
        try { app.endUndoGroup(); } catch (eG2) {}
    }

    // =======================================================================
    // Report
    // =======================================================================

    hr('SUMMARY');
    var totalActions = 0;
    var kind;
    for (kind in counts) {
        if (counts.hasOwnProperty(kind)) {
            w('  ' + counts[kind] + '  ' + kind);
            totalActions += counts[kind];
        }
    }
    if (!totalActions) { w('  No actions.'); }
    w('');
    w('Items after: ' + proj.numItems + '  Comps after: ' + allComps().length);
    w('');
    w('STILL MANUAL:');
    w('  - Convert auto-sizing text boxes to fixed-size rectangles');
    w('  - Swap brand colours in the sidebar shape fills');
    w('  - File > Dependencies > Collect Files to a clean folder (clears the');
    w('    old absolute paths, which carry the username and customer name)');
    w('  - File > Save As with the new project name');
    w('  - Render a frame from each delivery comp and eyeball it');
    w('  - Re-run ae-audit-project.jsx');

    function writeReport() {
        var report = log.join('\n');
        var written = null;
        try {
            var base = proj.file
                ? proj.file.fsName.replace(/\.aepx?$/i, '')
                : (Folder.desktop.fsName + '/ae-project');
            var f = new File(base + '-sanitize' + (DRY_RUN ? '-dryrun' : '') + '.txt');
            f.encoding = 'UTF-8';
            if (f.open('w')) { f.write(report); f.close(); written = f.fsName; }
        } catch (eW) {}
        return written;
    }

    var path = writeReport();

    alert((DRY_RUN ? 'DRY RUN complete — nothing was modified.\n\n'
                   : 'Sanitize complete.\n\n') +
          totalActions + ' action(s) ' + (DRY_RUN ? 'planned' : 'applied') + '.\n' +
          'Comps now: ' + allComps().length + '   Items now: ' + proj.numItems + '\n\n' +
          (path ? 'Report:\n' + path : 'Could not write the report file.') +
          (DRY_RUN ? '\n\nReview it, then set DRY_RUN = false to apply.' : ''));

})();
