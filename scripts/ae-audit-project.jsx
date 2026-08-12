/**
 * ae-audit-project.jsx
 *
 * Read-only audit of an After Effects project, written for sanitizing
 * broadcast graphics templates before they are shared externally or
 * committed to a sample repo.
 *
 * Reports:
 *   1. Project summary (comps, footage, solids, folders)
 *   2. Composition inventory with dimensions / frame rate / duration
 *   3. Text layers with their PostScript font names  (font swap checklist)
 *   4. Font inventory: which fonts are used by which layers
 *   5. Footage sources and absolute file paths        (path leak check)
 *   6. Brand-string scan across names, text and paths (leak check)
 *   7. Unused project items                           (deletion candidates)
 *   8. Lottie / lottie-web compatibility warnings
 *   9. Renderer layer-name contract check
 *
 * Usage:
 *   1. Enable Preferences > Scripting & Expressions >
 *      "Allow Scripts to Write Files and Access Network"
 *   2. Open the project in After Effects
 *   3. File > Scripts > Run Script File...  and select this file
 *
 * The report is written next to the project file as
 * {projectname}-audit.txt and a summary is shown in a dialog.
 *
 * This script only reads the project. It makes no modifications.
 *
 * ExtendScript (ES3) — no let/const, arrow functions, or JSON object.
 */

(function aeAuditProject() {

    // -----------------------------------------------------------------------
    // Configuration
    // -----------------------------------------------------------------------

    // Audit only the comps selected in the Project panel, plus every precomp
    // nested inside them. Set to false to audit the entire project.
    //
    // Recommended workflow for a large toolkit project: select just the comps
    // you intend to deliver, leave this true, and the report covers only those
    // comps and their dependencies.
    var SCOPE_SELECTED_ONLY = true;

    // Max items listed per finding group before collapsing to a count.
    var MAX_LIST = 25;

    // Case-insensitive substrings treated as customer / brand identifiers.
    // Add the outgoing customer's names, station callsigns, staff names and
    // your own OS username here before running.
    var BRAND_KEYWORDS = [
        // networks / stations
        'cnn', 'sinclair', 'wbff', 'whp', 'fox45', 'fox 45', 'fox',
        'nbc', 'abc', 'cbs', 'espn', 'bbc', 'sky', 'globo',
        // proprietary fonts
        'proxima', 'walsheim', 'gtwalsheim', 'cnnsans',
        // people / machines / internal jargon  (edit these)
        'wildesmj', 'kalin', 'cuttingroom',
        // editorial franchises / branded segments — easy to miss because they
        // carry no callsign
        'crisis-in-the-classroom', 'world series'
    ];

    // Fonts considered safe to redistribute (open licence).
    var OPEN_FONTS = [
        'roboto', 'inter', 'opensans', 'open sans', 'notosans', 'noto sans',
        'sourcesans', 'source sans', 'lato', 'montserrat', 'dejavu',
        'liberation', 'ibmplex', 'ibm plex', 'worksans', 'work sans'
    ];

    // Layer names the graphics-overlay-handler patches at render time.
    var CONTRACT_TEXT_LAYERS = [
        'Line 1', 'Line 2', 'Line 3', 'Location/Courtesy', 'body text'
    ];

    // The category label layer. Either name is accepted by index.py;
    // 'Category Label' is preferred for new templates.
    var CONTRACT_LABEL_LAYERS = ['Category Label', 'BREAKING NEWS'];

    // name -> required? Optional controls only warn when a template actually
    // uses the feature they drive.
    var CONTRACT_CONTROL_LAYERS = [
        { name: 'Line Control',    required: true },
        { name: 'sidebar control', required: false }
    ];

    // Expressions genuinely unsupported by lottie-web.
    //
    // NOTE: thisComp.layer("name").effect(...) references ARE supported and are
    // relied on in production by lambda/graphics-overlay-handler/index.py, which
    // drives category selection through opacity expressions on sidebar layers.
    // Do not add a bare 'layer(' pattern here — it produces false positives.
    var UNSUPPORTED_EXPR = [
        'sourceRectAtTime', 'sampleImage', 'toComp', 'fromComp',
        'toWorld', 'fromWorld', 'lookAt'
    ];

    // Stock / third-party asset providers whose licences generally forbid
    // redistribution inside a reusable template.
    var STOCK_MARKERS = [
        'adobestock', 'gettyimages', 'getty', 'shutterstock', 'istock',
        'unsplash', 'pexels', 'screenshot'
    ];

    // Strings that look like brand hits but are not. Glyph specimen layers
    // exist to force Bodymovin to bake a full character set.
    var FALSE_POSITIVE_MARKERS = ['ABCDEFGHIJKLMNOP'];

    var MAX_EXPR_DEPTH = 4;   // property-tree recursion limit
    var TEXT_PREVIEW = 60;    // chars of text content shown per layer

    // -----------------------------------------------------------------------
    // Output buffer
    // -----------------------------------------------------------------------

    var out = [];

    // Findings are aggregated by signature so a pattern repeated across 160
    // comps reports once with a count and examples, instead of 160 lines.
    var findingKeys = [];                 // ordered signatures
    var findingMap = {};                  // signature -> {sev, count, examples[]}

    function w(s) { out.push(s === undefined ? '' : String(s)); }
    function hr(title) {
        w('');
        w('========================================================================');
        w(' ' + title);
        w('========================================================================');
    }

    /**
     * Record a finding.
     * @param severity  FAIL | LEAK | LICENCE | WARN
     * @param signature de-duplication key — describes the KIND of problem
     * @param example   optional specific instance (comp / layer, value, ...)
     */
    function flag(severity, signature, example) {
        var key = severity + '|' + signature;
        if (!findingMap[key]) {
            findingMap[key] = { sev: severity, sig: signature, count: 0, examples: [] };
            findingKeys.push(key);
        }
        var rec = findingMap[key];
        rec.count++;
        if (example && rec.examples.length < 5) {
            rec.examples.push(String(example));
        }
    }

    function severityTotal(sev) {
        var n = 0;
        for (var a = 0; a < findingKeys.length; a++) {
            if (findingMap[findingKeys[a]].sev === sev) {
                n += findingMap[findingKeys[a]].count;
            }
        }
        return n;
    }

    function pad(s, n) {
        s = String(s === undefined || s === null ? '' : s);
        while (s.length < n) { s += ' '; }
        return s;
    }

    function trunc(s, n) {
        s = String(s === undefined || s === null ? '' : s);
        s = s.replace(/[\r\n]+/g, ' ');
        return s.length > n ? s.substring(0, n - 3) + '...' : s;
    }

    function lower(s) { return String(s === undefined ? '' : s).toLowerCase(); }

    function trim(s) {
        return String(s === undefined || s === null ? '' : s).replace(/^\s+|\s+$/g, '');
    }

    function indexOfCI(arr, needle) {
        var n = lower(needle);
        for (var i = 0; i < arr.length; i++) {
            if (lower(arr[i]) === n) { return i; }
        }
        return -1;
    }

    function isFalsePositive(haystack) {
        var h = String(haystack === undefined ? '' : haystack);
        for (var a = 0; a < FALSE_POSITIVE_MARKERS.length; a++) {
            if (h.indexOf(FALSE_POSITIVE_MARKERS[a]) !== -1) { return true; }
        }
        return false;
    }

    /**
     * Case-insensitive substring scan.
     *
     * Keywords of 4 characters or fewer (network acronyms such as abc, cbs,
     * fox) must start at a word boundary, otherwise "abc" matches the glyph
     * specimen string "abcdefghij...". Longer keywords match anywhere.
     */
    function matteTypeName(t) {
        try {
            if (t === TrackMatteType.ALPHA) { return 'alpha matte'; }
            if (t === TrackMatteType.ALPHA_INVERTED) { return 'alpha inverted matte'; }
            if (t === TrackMatteType.LUMA) { return 'luma matte'; }
            if (t === TrackMatteType.LUMA_INVERTED) { return 'luma inverted matte'; }
        } catch (e) {}
        return 'matte type ' + t;
    }

    function containsAny(haystack, list) {
        var raw = String(haystack === undefined ? '' : haystack);
        if (isFalsePositive(raw)) { return []; }
        var h = lower(raw);
        var hits = [];
        for (var i = 0; i < list.length; i++) {
            var kw = lower(list[i]);
            if (!kw.length) { continue; }
            var found = false;
            if (kw.length <= 4) {
                var from = 0;
                while (true) {
                    var at = h.indexOf(kw, from);
                    if (at === -1) { break; }
                    var before = at === 0 ? '' : h.charAt(at - 1);
                    if (at === 0 || !/[a-z0-9]/.test(before)) { found = true; break; }
                    from = at + 1;
                }
            } else {
                found = h.indexOf(kw) !== -1;
            }
            if (found) { hits.push(list[i]); }
        }
        return hits;
    }

    // -----------------------------------------------------------------------
    // Guards
    // -----------------------------------------------------------------------

    if (!app.project) {
        alert('No project is open.');
        return;
    }

    var proj = app.project;

    // -----------------------------------------------------------------------
    // Collect items
    // -----------------------------------------------------------------------

    var comps = [];
    var footages = [];
    var solids = [];
    var folders = [];
    var placeholders = [];

    var i, j, k;

    for (i = 1; i <= proj.numItems; i++) {
        var it = proj.item(i);
        if (it instanceof CompItem) {
            comps.push(it);
        } else if (it instanceof FolderItem) {
            folders.push(it);
        } else if (it instanceof FootageItem) {
            var src = null;
            try { src = it.mainSource; } catch (e0) { src = null; }
            if (src && src instanceof SolidSource) {
                solids.push(it);
            } else if (src && src instanceof PlaceholderSource) {
                placeholders.push(it);
            } else {
                footages.push(it);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Scope: optionally narrow to selected comps + their nested precomps
    // -----------------------------------------------------------------------

    var allComps = comps;
    var scopeNote = 'entire project (' + comps.length + ' comps)';

    function collectNested(comp, acc, seen) {
        var id = comp.id;
        if (seen['c' + id]) { return; }
        seen['c' + id] = true;
        acc.push(comp);
        for (var a = 1; a <= comp.numLayers; a++) {
            var src = null;
            try { src = comp.layer(a).source; } catch (eN) { src = null; }
            if (src && src instanceof CompItem) {
                collectNested(src, acc, seen);
            }
        }
    }

    if (SCOPE_SELECTED_ONLY) {
        var sel = [];
        try { sel = proj.selection; } catch (eS) { sel = []; }
        var selComps = [];
        for (i = 0; i < sel.length; i++) {
            if (sel[i] instanceof CompItem) { selComps.push(sel[i]); }
        }
        if (selComps.length) {
            var scoped = [];
            var seenIds = {};
            for (i = 0; i < selComps.length; i++) {
                collectNested(selComps[i], scoped, seenIds);
            }
            comps = scoped;
            scopeNote = selComps.length + ' selected comp(s) + nested precomps = ' +
                        comps.length + ' of ' + allComps.length + ' comps';
        } else {
            scopeNote = 'entire project (' + comps.length +
                        ' comps) — nothing selected in the Project panel';
        }
    }

    // -----------------------------------------------------------------------
    // Header
    // -----------------------------------------------------------------------

    var projName = proj.file ? proj.file.name : '(unsaved project)';
    var projPath = proj.file ? proj.file.fsName : '(not saved to disk)';

    w('After Effects Project Audit');
    w('Generated: ' + new Date().toString());
    w('AE version: ' + app.version);
    w('Project: ' + projName);
    w('Path: ' + projPath);
    w('Items: ' + proj.numItems + '  (comps: ' + allComps.length +
      ', footage: ' + footages.length + ', solids: ' + solids.length +
      ', placeholders: ' + placeholders.length + ', folders: ' + folders.length + ')');
    w('Bits per channel: ' + proj.bitsPerChannel);
    w('AUDIT SCOPE: ' + scopeNote);

    if (projName.indexOf(' ') !== -1) {
        flag('WARN', 'Project filename contains spaces', projName);
    }
    var projBrand = containsAny(projName, BRAND_KEYWORDS);
    if (projBrand.length) {
        flag('LEAK', 'Project filename contains brand keyword(s)',
             projName + '  ->  ' + projBrand.join(', '));
    }
    var pathBrand = containsAny(projPath, BRAND_KEYWORDS);
    if (pathBrand.length) {
        flag('LEAK', 'Project folder path contains brand keyword(s) / usernames',
             projPath + '  ->  ' + pathBrand.join(', '));
    }

    // -----------------------------------------------------------------------
    // 1. Compositions
    // -----------------------------------------------------------------------

    hr('1. COMPOSITIONS');
    w(pad('NAME', 42) + pad('SIZE', 12) + pad('FPS', 8) +
      pad('DUR(s)', 9) + pad('LAYERS', 8) + 'USED IN');
    w(pad('----', 42) + pad('----', 12) + pad('---', 8) +
      pad('------', 9) + pad('------', 8) + '-------');

    for (i = 0; i < comps.length; i++) {
        var c = comps[i];
        var usedIn = 0;
        try { usedIn = c.usedIn.length; } catch (e1) { usedIn = -1; }
        w(pad(trunc(c.name, 40), 42) +
          pad(c.width + 'x' + c.height, 12) +
          pad(Math.round(c.frameRate * 100) / 100, 8) +
          pad(Math.round(c.duration * 100) / 100, 9) +
          pad(c.numLayers, 8) +
          (usedIn === 0 ? 'TOP-LEVEL' : usedIn + ' comp(s)'));

        var cBrand = containsAny(c.name, BRAND_KEYWORDS);
        if (cBrand.length) {
            flag('LEAK', 'Comp name contains brand keyword: ' + cBrand.join(', '), c.name);
        }

        // Render cost: every frame is rasterised through Puppeteer then piped
        // to FFmpeg, so long comps dominate the graphics-overlay Lambda runtime.
        var usedInTop = (usedIn === 0);
        var frames = Math.round(c.duration * c.frameRate);
        if (usedInTop && frames > 1800) {
            flag('WARN', 'Delivery comp longer than 60s (' + frames + ' frames) — ' +
                 'consider trimming or capping maxFrames at render time',
                 c.name + '  ' + Math.round(c.duration) + 's');
        }
    }

    // -----------------------------------------------------------------------
    // 2. Text layers + font inventory
    // -----------------------------------------------------------------------

    hr('2. TEXT LAYERS  (font swap checklist)');

    var fontUsage = {};      // postscript name -> array of "comp / layer"
    var textLayerCount = 0;
    var contractFound = {};

    for (i = 0; i < CONTRACT_TEXT_LAYERS.length; i++) {
        contractFound[CONTRACT_TEXT_LAYERS[i]] = 0;
    }

    w(pad('COMP', 26) + pad('LAYER', 34) + pad('FONT (PostScript)', 30) +
      pad('SIZE', 7) + 'TEXT');
    w(pad('----', 26) + pad('-----', 34) + pad('-----------------', 30) +
      pad('----', 7) + '----');

    for (i = 0; i < comps.length; i++) {
        var comp = comps[i];
        for (j = 1; j <= comp.numLayers; j++) {
            var lyr = comp.layer(j);
            if (!(lyr instanceof TextLayer)) { continue; }
            textLayerCount++;

            var td = null;
            var fontName = '(unreadable)';
            var fontSize = '';
            var textVal = '';
            try {
                td = lyr.property('Source Text').value;
                fontName = td.font;
                fontSize = Math.round(td.fontSize * 10) / 10;
                textVal = td.text;
            } catch (e2) {
                fontName = '(error reading TextDocument)';
            }

            w(pad(trunc(comp.name, 24), 26) +
              pad(trunc(lyr.name, 32), 34) +
              pad(trunc(fontName, 28), 30) +
              pad(fontSize, 7) +
              trunc(textVal, TEXT_PREVIEW));

            if (!fontUsage[fontName]) { fontUsage[fontName] = []; }
            fontUsage[fontName].push(comp.name + ' / ' + lyr.name);

            // contract check
            for (k = 0; k < CONTRACT_TEXT_LAYERS.length; k++) {
                if (lyr.name === CONTRACT_TEXT_LAYERS[k]) {
                    contractFound[CONTRACT_TEXT_LAYERS[k]]++;
                }
            }

            // brand scan on layer name + text content
            var lBrand = containsAny(lyr.name + ' ' + textVal, BRAND_KEYWORDS);
            if (lBrand.length) {
                flag('LEAK', 'Text layer name/content contains brand keyword: ' +
                     lBrand.join(', '), comp.name + ' / ' + lyr.name);
            }

            // keyframed source text is a render-time patching hazard
            try {
                if (lyr.property('Source Text').numKeys > 0) {
                    flag('WARN', 'Source Text is keyframed — render-time text ' +
                         'patching may be overridden', comp.name + ' / ' + lyr.name);
                }
            } catch (e3) {}
        }
    }

    w('');
    w('Total text layers: ' + textLayerCount);

    hr('3. FONT INVENTORY');
    var fname;
    var openCount = 0, closedCount = 0;
    for (fname in fontUsage) {
        if (!fontUsage.hasOwnProperty(fname)) { continue; }
        var isOpen = containsAny(fname, OPEN_FONTS).length > 0;
        if (isOpen) { openCount++; } else { closedCount++; }
        w('');
        w((isOpen ? '[open]   ' : '[LICENCE] ') + fname +
          '   (' + fontUsage[fname].length + ' layer(s))');
        for (j = 0; j < fontUsage[fname].length; j++) {
            w('    - ' + fontUsage[fname][j]);
        }
        if (!isOpen) {
            flag('LICENCE', 'Font not in known-open list — outlines would be baked ' +
                 'into the Lottie export: ' + fname,
                 fontUsage[fname].length + ' layer(s), e.g. ' + fontUsage[fname][0]);
        }
    }
    w('');
    w('Font families: ' + (openCount + closedCount) +
      '  (open: ' + openCount + ', needs review: ' + closedCount + ')');

    // -----------------------------------------------------------------------
    // 4. Footage / sources
    // -----------------------------------------------------------------------

    hr('4. FOOTAGE SOURCES  (absolute paths leak machine + customer names)');

    if (!footages.length) {
        w('(none)');
    } else {
        for (i = 0; i < footages.length; i++) {
            var fi = footages[i];
            var fpath = '(no file)';
            var missing = false;
            try {
                if (fi.mainSource && fi.mainSource.file) {
                    fpath = fi.mainSource.file.fsName;
                    missing = !fi.mainSource.file.exists;
                }
            } catch (e4) {}
            var usedInCount = -1;
            try { usedInCount = fi.usedIn.length; } catch (e5) {}

            w('');
            w('  ' + fi.name + (missing ? '   *** MISSING ***' : ''));
            w('    path:    ' + fpath);
            w('    size:    ' + fi.width + 'x' + fi.height);
            w('    used in: ' + (usedInCount < 0 ? '?' : usedInCount) + ' comp(s)');

            if (missing) {
                flag('FAIL', 'Missing footage — export will be incomplete', fi.name);
            }
            if (usedInCount === 0) {
                flag('WARN', 'Unused footage item (deletion candidate)', fi.name);
            }
            var fBrand = containsAny(fi.name, BRAND_KEYWORDS);
            if (fBrand.length) {
                flag('LEAK', 'Footage name contains brand keyword: ' +
                     fBrand.join(', '), fi.name);
            }
            var fStock = containsAny(fi.name + ' ' + fpath, STOCK_MARKERS);
            if (fStock.length) {
                flag('LICENCE', 'Stock / third-party asset (' + fStock.join(', ') +
                     ') — standard stock licences do not permit redistribution ' +
                     'inside a reusable template', fi.name);
            }
        }
    }

    if (placeholders.length) {
        w('');
        w('  Placeholders (missing/offline media):');
        for (i = 0; i < placeholders.length; i++) {
            w('    - ' + placeholders[i].name);
            flag('FAIL', 'Placeholder source present (offline media)', placeholders[i].name);
        }
    }

    // -----------------------------------------------------------------------
    // 5. Unused items
    // -----------------------------------------------------------------------

    hr('5. UNUSED ITEMS  (deletion candidates)');
    var unusedCount = 0;

    function reportUnused(list, label) {
        for (var a = 0; a < list.length; a++) {
            var u = -1;
            try { u = list[a].usedIn.length; } catch (e6) { continue; }
            if (u === 0) {
                // top-level comps are legitimately "unused"
                if (list[a] instanceof CompItem) { continue; }
                w('  [' + label + '] ' + list[a].name);
                unusedCount++;
            }
        }
    }
    reportUnused(footages, 'footage');
    reportUnused(solids, 'solid');

    if (!unusedCount) { w('  (none)'); }
    w('');
    w('Tip: File > Dependencies > Remove Unused Footage, then Reduce Project');
    w('     with your delivery comps selected, removes these in one pass.');

    // -----------------------------------------------------------------------
    // 6. Layer-level compatibility scan
    // -----------------------------------------------------------------------

    hr('6. LOTTIE / LOTTIE-WEB COMPATIBILITY');

    var exprHits = [];
    var matteHits = [];
    var effectHits = [];
    var shyHits = [];
    var disabledHits = [];
    var blendHits = [];
    var dropdowns = [];

    function scanExpressions(prop, where, depth) {
        if (depth > MAX_EXPR_DEPTH) { return; }
        var n = 0;
        try { n = prop.numProperties; } catch (e7) { return; }
        for (var p = 1; p <= n; p++) {
            var sub;
            try { sub = prop.property(p); } catch (e8) { continue; }
            if (!sub) { continue; }
            try {
                if (sub.canSetExpression && sub.expressionEnabled && sub.expression) {
                    var bad = containsAny(sub.expression, UNSUPPORTED_EXPR);
                    exprHits.push({
                        where: where,
                        prop: sub.name,
                        expr: trunc(sub.expression, 90),
                        unsupported: bad
                    });
                }
            } catch (e9) {}
            if (sub.numProperties) {
                scanExpressions(sub, where, depth + 1);
            }
        }
    }

    for (i = 0; i < comps.length; i++) {
        var cc = comps[i];
        for (j = 1; j <= cc.numLayers; j++) {
            var L = cc.layer(j);
            var where = cc.name + ' / ' + L.name;

            if (L.shy) { shyHits.push(where); }
            if (!L.enabled) { disabledHits.push(where); }

            // Track mattes.
            //
            // AE 23+ assigns mattes by layer reference (trackMatteLayer). The
            // older trackMatteType property persists as a mode value even when
            // no matte is assigned, so testing it alone reports mattes that do
            // not exist. Only a non-null trackMatteLayer means a real matte.
            try {
                var matteLayer = null;
                try { matteLayer = L.trackMatteLayer; } catch (eMl) { matteLayer = null; }

                if (matteLayer) {
                    matteHits.push(where + '  (' + matteTypeName(L.trackMatteType) +
                                   ' from "' + matteLayer.name + '")');
                } else if (L.trackMatteType &&
                           L.trackMatteType !== TrackMatteType.NO_TRACK_MATTE) {
                    // Mode value left over from a previous assignment. Not a
                    // matte, and not exported. Reported for information only.
                    matteHits.push(where + '  (no matte assigned; leftover mode: ' +
                                   matteTypeName(L.trackMatteType) + ')');
                }
            } catch (e10) {}
            try {
                if (L.isTrackMatte) { matteHits.push(where + '  (matte SOURCE)'); }
            } catch (e11) {}

            // blend modes other than normal
            try {
                if (L.blendingMode && L.blendingMode !== BlendingMode.NORMAL) {
                    blendHits.push(where + '  (mode ' + L.blendingMode + ')');
                }
            } catch (e12) {}

            // effects
            try {
                var fx = L.property('ADBE Effect Parade');
                if (fx && fx.numProperties > 0) {
                    for (k = 1; k <= fx.numProperties; k++) {
                        var ef = fx.property(k);
                        effectHits.push(where + '  ->  ' + ef.name +
                                        '  [' + ef.matchName + ']');
                        if (ef.matchName === 'ADBE Dropdown Control') {
                            var val = '?';
                            try { val = ef.property(1).value; } catch (e13) {}
                            dropdowns.push(where + '  ->  "' + ef.name +
                                           '"  current value: ' + val);
                        }
                    }
                }
            } catch (e14) {}

            scanExpressions(L, where, 0);

            // brand scan on every layer name
            var nBrand = containsAny(L.name, BRAND_KEYWORDS);
            if (nBrand.length) {
                flag('LEAK', 'Layer name contains brand keyword: ' + nBrand.join(', '), where);
            }

            // Leading / trailing whitespace breaks the renderer's exact-match
            // layer lookups (e.g. nm == 'BREAKING NEWS' in index.py).
            if (L.name !== String(L.name).replace(/^\s+|\s+$/g, '')) {
                flag('FAIL', 'Layer name has leading/trailing whitespace — breaks ' +
                     'exact-name matching in the renderer',
                     cc.name + ' / "' + L.name + '"');
            }
        }
    }

    w('');
    w('-- Expressions (' + exprHits.length + ') ------------------------------');
    if (!exprHits.length) { w('  (none)'); }
    for (i = 0; i < exprHits.length; i++) {
        var eh = exprHits[i];
        w('  ' + eh.where + '  ->  ' + eh.prop);
        w('      ' + eh.expr);
        if (eh.unsupported.length) {
            w('      *** UNSUPPORTED by lottie-web: ' + eh.unsupported.join(', '));
            flag('FAIL', 'Expression unsupported by lottie-web: ' +
                 eh.unsupported.join(', '), eh.where + ' -> ' + eh.prop);
        }
    }

    w('');
    w('-- Track mattes (' + matteHits.length + ') ----------------------------');
    if (!matteHits.length) { w('  (none)'); }
    for (i = 0; i < matteHits.length; i++) { w('  ' + matteHits[i]); }
    for (i = 0; i < matteHits.length; i++) {
        // Leftover mode values are not real mattes — informational only.
        if (matteHits[i].indexOf('no matte assigned') !== -1) { continue; }
        flag('WARN', 'Track matte in use — lottie-web renders these only when the ' +
             'matte source has no unsupported expressions, and index.py currently ' +
             'strips all mattes (_hide_matte_layers). Prefer an animated mask for ' +
             'reveals', matteHits[i]);
    }

    w('');
    w('-- Non-normal blend modes (' + blendHits.length + ') -----------------');
    if (!blendHits.length) { w('  (none)'); }
    for (i = 0; i < blendHits.length; i++) { w('  ' + blendHits[i]); }
    for (i = 0; i < blendHits.length; i++) {
        flag('WARN', 'Non-normal blend mode — limited Lottie support', blendHits[i]);
    }

    w('');
    w('-- Dropdown controls (' + dropdowns.length + ') ----------------------');
    if (!dropdowns.length) { w('  (none)'); }
    for (i = 0; i < dropdowns.length; i++) { w('  ' + dropdowns[i]); }

    w('');
    w('-- All effects (' + effectHits.length + ') ---------------------------');
    if (!effectHits.length) { w('  (none)'); }
    for (i = 0; i < effectHits.length; i++) { w('  ' + effectHits[i]); }

    w('');
    w('-- Shy layers (' + shyHits.length + ') -------------------------------');
    for (i = 0; i < shyHits.length; i++) { w('  ' + shyHits[i]); }
    for (i = 0; i < shyHits.length; i++) {
        flag('WARN', 'Shy layer hidden in the timeline — un-shy before reviewing ' +
             'for deletion', shyHits[i]);
    }

    w('');
    w('-- Disabled layers (' + disabledHits.length + ') ---------------------');
    for (i = 0; i < disabledHits.length; i++) { w('  ' + disabledHits[i]); }
    for (i = 0; i < disabledHits.length; i++) {
        flag('WARN', 'Disabled layer (deletion candidate)', disabledHits[i]);
    }

    // -----------------------------------------------------------------------
    // 7. Renderer contract check
    // -----------------------------------------------------------------------

    hr('7. RENDERER LAYER-NAME CONTRACT');
    w('Expected by lambda/graphics-overlay-handler/index.py:');
    w('');
    var cname;
    for (i = 0; i < CONTRACT_TEXT_LAYERS.length; i++) {
        cname = CONTRACT_TEXT_LAYERS[i];
        var cnt = contractFound[cname];
        w('  ' + pad(cname, 24) + (cnt > 0 ? 'found in ' + cnt + ' comp(s)' : 'NOT FOUND'));
        if (!cnt) {
            flag('WARN', 'Contract text layer not found — renderer will not patch it',
                 cname);
        }
    }
    // Category label — either accepted name counts.
    var labelCount = 0, labelNameUsed = '';
    for (j = 0; j < comps.length; j++) {
        for (k = 1; k <= comps[j].numLayers; k++) {
            var lname = trim(comps[j].layer(k).name);
            if (indexOfCI(CONTRACT_LABEL_LAYERS, lname) !== -1) {
                labelCount++;
                if (!labelNameUsed) { labelNameUsed = lname; }
            }
        }
    }
    w('  ' + pad('Category label', 24) +
      (labelCount > 0
          ? 'found in ' + labelCount + ' comp(s) as "' + labelNameUsed + '"'
          : 'NOT FOUND  (expected one of: ' + CONTRACT_LABEL_LAYERS.join(', ') + ')'));
    if (!labelCount) {
        flag('WARN', 'Category label layer not found — the category name will not ' +
             'be patched. Expected one of: ' + CONTRACT_LABEL_LAYERS.join(', '), '');
    }

    w('');
    for (i = 0; i < CONTRACT_CONTROL_LAYERS.length; i++) {
        cname = CONTRACT_CONTROL_LAYERS[i].name;
        var required = CONTRACT_CONTROL_LAYERS[i].required;
        var foundCtl = 0;
        for (j = 0; j < comps.length; j++) {
            for (k = 1; k <= comps[j].numLayers; k++) {
                if (trim(comps[j].layer(k).name) === cname) { foundCtl++; }
            }
        }
        w('  ' + pad(cname, 24) +
          (foundCtl > 0
              ? 'found in ' + foundCtl + ' comp(s)'
              : (required ? 'NOT FOUND' : 'not present (optional)')));
        if (!foundCtl && required) {
            flag('WARN', 'Contract control layer not found', cname);
        }
    }

    // -----------------------------------------------------------------------
    // 8. Summary
    // -----------------------------------------------------------------------

    hr('8. SUMMARY OF FINDINGS');

    if (!findingKeys.length) {
        w('  No issues found.');
    } else {
        w('Findings are grouped by kind. "xN" is the number of occurrences.');
        var order = ['FAIL', 'LEAK', 'LICENCE', 'WARN'];
        for (i = 0; i < order.length; i++) {
            var any = false;
            for (j = 0; j < findingKeys.length; j++) {
                var rec = findingMap[findingKeys[j]];
                if (rec.sev !== order[i]) { continue; }
                if (!any) {
                    w('');
                    w('-- ' + order[i] + '  (' + severityTotal(order[i]) +
                      ' occurrence(s)) --');
                    any = true;
                }
                w('');
                w('  x' + rec.count + '  ' + rec.sig);
                for (k = 0; k < rec.examples.length; k++) {
                    w('        e.g. ' + rec.examples[k]);
                }
                if (rec.count > rec.examples.length) {
                    w('        ... and ' + (rec.count - rec.examples.length) + ' more');
                }
            }
        }
    }

    w('');
    w('Legend:');
    w('  FAIL    — will break the Lottie export or the server-side render');
    w('  LEAK    — customer / brand identifier that must not ship externally');
    w('  LICENCE — proprietary font whose outlines would be baked into the export');
    w('  WARN    — review before delivery');

    // -----------------------------------------------------------------------
    // Write report
    // -----------------------------------------------------------------------

    var report = out.join('\n');
    var written = null;

    try {
        var base = proj.file
            ? proj.file.fsName.replace(/\.aepx?$/i, '')
            : (Folder.desktop.fsName + '/ae-project');
        var f = new File(base + '-audit.txt');
        f.encoding = 'UTF-8';
        if (f.open('w')) {
            f.write(report);
            f.close();
            written = f.fsName;
        }
    } catch (eWrite) {
        written = null;
    }

    function kindsOf(sev) {
        var n = 0;
        for (var a = 0; a < findingKeys.length; a++) {
            if (findingMap[findingKeys[a]].sev === sev) { n++; }
        }
        return n;
    }

    function line(sev) {
        return sev + ': ' + kindsOf(sev) + ' kind(s), ' +
               severityTotal(sev) + ' occurrence(s)\n';
    }

    var msg = 'Audit complete.\n\n' +
        'Scope: ' + scopeNote + '\n' +
        'Text layers: ' + textLayerCount + '\n' +
        'Fonts needing review: ' + closedCount + '\n\n' +
        line('FAIL') + line('LEAK') + line('LICENCE') + line('WARN') + '\n' +
        (written
            ? 'Report written to:\n' + written
            : 'Could not write the report file. Enable Preferences >\n' +
              'Scripting & Expressions > "Allow Scripts to Write Files\n' +
              'and Access Network", or copy it from the clipboard.');

    alert(msg);

    // Also put the report on the clipboard as a fallback.
    try {
        var tmp = new File(Folder.temp.fsName + '/ae-audit-clip.txt');
        tmp.encoding = 'UTF-8';
        tmp.open('w'); tmp.write(report); tmp.close();
    } catch (eClip) {}

})();
