/**
 * ae-inspect-layers.jsx
 *
 * Read-only deep dump of specific layers: transforms with their current
 * values, every keyframe, expressions, parenting, shape contents, masks and
 * effects.
 *
 * Built for diagnosing "the animation changed and I don't know why". The audit
 * script reports structure; this one reports the numbers behind it.
 *
 * TYPICAL USE — find what changed between two versions of a project:
 *   1. Open the BACKUP project, run this, keep the report
 *   2. Open the CURRENT project, run this again
 *   3. Compare the two reports — the differing values are your answer
 *
 * Usage:
 *   1. Enable Preferences > Scripting & Expressions >
 *      "Allow Scripts to Write Files and Access Network"
 *   2. Open the project. Optionally select comps in the Project panel.
 *   3. File > Scripts > Run Script File...
 *
 * The report is written next to the project as {name}-inspect.txt
 *
 * This script only reads. It makes no modifications.
 *
 * ExtendScript (ES3) — no let/const, arrow functions, or JSON object.
 */

(function aeInspectLayers() {

    // =======================================================================
    // CONFIG
    // =======================================================================

    // Only inspect layers whose name contains one of these (case-insensitive).
    // Empty array = every layer.
    var LAYER_NAME_FILTER = [
        'TextBox',
        'Category Label',
        'Location/Courtesy'
    ];

    // Only inspect these comps. Empty array = comps selected in the Project
    // panel, or all comps when nothing is selected.
    var COMP_NAME_FILTER = [];

    // Also walk shape layer Contents (rectangle size/position, fills, strokes).
    var INCLUDE_SHAPE_CONTENTS = true;

    // Max keyframes printed per property.
    var MAX_KEYS = 12;

    // Recursion limit for shape contents / property groups.
    var MAX_DEPTH = 6;

    // =======================================================================
    // Helpers
    // =======================================================================

    var log = [];

    function w(s) { log.push(s === undefined ? '' : String(s)); }
    function hr(t) {
        w('');
        w('========================================================================');
        w(' ' + t);
        w('========================================================================');
    }
    function pad(s, n) {
        s = String(s === undefined || s === null ? '' : s);
        while (s.length < n) { s += ' '; }
        return s;
    }
    function lower(s) { return String(s === undefined ? '' : s).toLowerCase(); }

    function matchesAny(s, list) {
        if (!list || !list.length) { return true; }
        var h = lower(s);
        for (var a = 0; a < list.length; a++) {
            if (h.indexOf(lower(list[a])) !== -1) { return true; }
        }
        return false;
    }

    function round(n, dp) {
        var f = Math.pow(10, dp === undefined ? 2 : dp);
        return Math.round(n * f) / f;
    }

    // Format a property value: numbers, arrays, colours, TextDocument, shapes.
    function fmt(v) {
        if (v === undefined) { return '(undefined)'; }
        if (v === null) { return '(null)'; }
        try {
            if (typeof v === 'number') { return String(round(v, 3)); }
            if (typeof v === 'boolean' || typeof v === 'string') { return String(v); }
            if (v.length !== undefined && typeof v.length === 'number') {
                var parts = [];
                for (var a = 0; a < v.length; a++) {
                    parts.push(typeof v[a] === 'number' ? String(round(v[a], 3)) : String(v[a]));
                }
                return '[' + parts.join(', ') + ']';
            }
            // TextDocument
            if (v.text !== undefined) {
                return 'text="' + String(v.text).replace(/[\r\n]+/g, ' ').substring(0, 40) +
                       '" font=' + v.font + ' size=' + round(v.fontSize, 1) +
                       (v.boxText !== undefined ? ' boxText=' + v.boxText : '') +
                       (v.boxTextSize !== undefined ? ' boxSize=' + fmt(v.boxTextSize) : '');
            }
            // Shape (path)
            if (v.vertices !== undefined) {
                return 'path with ' + v.vertices.length + ' vertices, closed=' + v.closed;
            }
        } catch (e) {}
        return String(v);
    }

    function timecode(t) {
        return round(t, 3) + 's';
    }

    // =======================================================================
    // Property reporting
    // =======================================================================

    function reportProp(p, indent) {
        var name;
        try { name = p.name; } catch (e0) { return; }

        var line = indent + pad(name, 22);
        var bits = [];

        // current value
        try {
            if (p.value !== undefined) { bits.push('= ' + fmt(p.value)); }
        } catch (e1) { bits.push('= (unreadable)'); }

        // expression
        var hasExpr = false;
        try {
            if (p.canSetExpression && p.expression) {
                hasExpr = true;
                bits.push(p.expressionEnabled ? '[EXPR]' : '[expr disabled]');
            }
        } catch (e2) {}

        // keyframes
        var nk = 0;
        try { nk = p.numKeys || 0; } catch (e3) { nk = 0; }
        if (nk) { bits.push(nk + ' keys'); }

        w(line + bits.join('  '));

        if (hasExpr) {
            var ex = '';
            try { ex = String(p.expression).replace(/[\r\n]+/g, ' '); } catch (e4) {}
            w(indent + '    expr: ' + ex.substring(0, 160));
        }

        if (nk) {
            var shown = Math.min(nk, MAX_KEYS);
            for (var ki = 1; ki <= shown; ki++) {
                var kt = '?', kv = '?';
                try { kt = timecode(p.keyTime(ki)); } catch (e5) {}
                try { kv = fmt(p.keyValue(ki)); } catch (e6) {}
                w(indent + '    key ' + pad(ki, 3) + pad(kt, 12) + kv);
            }
            if (nk > shown) {
                w(indent + '    ... and ' + (nk - shown) + ' more keys');
            }
        }
    }

    function walkGroup(group, indent, depth) {
        if (depth > MAX_DEPTH) { return; }
        var n = 0;
        try { n = group.numProperties; } catch (e0) { return; }
        for (var p = 1; p <= n; p++) {
            var sub;
            try { sub = group.property(p); } catch (e1) { continue; }
            if (!sub) { continue; }

            var isGroup = false;
            try { isGroup = (sub.numProperties && sub.numProperties > 0); } catch (e2) {}

            if (isGroup) {
                var gname = '';
                try { gname = sub.name; } catch (e3) { gname = '(group)'; }
                w(indent + '+ ' + gname);
                walkGroup(sub, indent + '    ', depth + 1);
            } else {
                reportProp(sub, indent);
            }
        }
    }

    // =======================================================================
    // Guards
    // =======================================================================

    if (!app.project) { alert('No project is open.'); return; }
    var proj = app.project;

    w('After Effects Layer Inspector');
    w('Generated: ' + new Date().toString());
    w('AE version: ' + app.version);
    w('Project: ' + (proj.file ? proj.file.name : '(unsaved)'));
    w('Current time: ' + '(per-comp, shown below)');
    w('Layer filter: ' + (LAYER_NAME_FILTER.length ? LAYER_NAME_FILTER.join(' | ') : '(all layers)'));

    // -----------------------------------------------------------------------
    // Choose comps
    // -----------------------------------------------------------------------

    var comps = [];
    var i, j;

    if (COMP_NAME_FILTER.length) {
        for (i = 1; i <= proj.numItems; i++) {
            var it0 = proj.item(i);
            if (it0 instanceof CompItem && matchesAny(it0.name, COMP_NAME_FILTER)) {
                comps.push(it0);
            }
        }
    } else {
        var sel = [];
        try { sel = proj.selection; } catch (eS) { sel = []; }
        for (i = 0; i < sel.length; i++) {
            if (sel[i] instanceof CompItem) { comps.push(sel[i]); }
        }
        if (!comps.length) {
            for (i = 1; i <= proj.numItems; i++) {
                if (proj.item(i) instanceof CompItem) { comps.push(proj.item(i)); }
            }
        }
    }

    w('Comps inspected: ' + comps.length);

    // -----------------------------------------------------------------------
    // Inspect
    // -----------------------------------------------------------------------

    var layersReported = 0;

    for (i = 0; i < comps.length; i++) {
        var comp = comps[i];
        hr('COMP: ' + comp.name);
        w('  ' + comp.width + 'x' + comp.height + '  ' + round(comp.frameRate, 2) + 'fps  ' +
          round(comp.duration, 2) + 's  ' + comp.numLayers + ' layers');
        w('  comp time (values below are sampled here): ' + timecode(comp.time));

        for (j = 1; j <= comp.numLayers; j++) {
            var L = comp.layer(j);
            if (!matchesAny(L.name, LAYER_NAME_FILTER)) { continue; }
            layersReported++;

            w('');
            w('------------------------------------------------------------------------');
            w('  LAYER ' + j + ': ' + L.name);
            w('------------------------------------------------------------------------');

            var kind = 'AVLayer';
            try {
                if (L instanceof TextLayer) { kind = 'TextLayer'; }
                else if (L instanceof ShapeLayer) { kind = 'ShapeLayer'; }
                else if (L.nullLayer) { kind = 'Null'; }
            } catch (eK) {}
            w('    type:      ' + kind);
            w('    enabled:   ' + L.enabled + '   shy: ' + L.shy);

            try {
                w('    parent:    ' + (L.parent ? L.parent.name : '(none)'));
            } catch (eP) {}

            try {
                w('    in/out:    ' + timecode(L.inPoint) + ' -> ' + timecode(L.outPoint));
            } catch (eIO) {}

            // Track matte — AE 23+ uses a layer reference
            try {
                var mLayer = null;
                try { mLayer = L.trackMatteLayer; } catch (eMl) { mLayer = null; }
                w('    matte:     ' + (mLayer ? mLayer.name + ' (type ' + L.trackMatteType + ')'
                                             : 'none' +
                                               (L.trackMatteType &&
                                                L.trackMatteType !== TrackMatteType.NO_TRACK_MATTE
                                                  ? '  [leftover mode ' + L.trackMatteType + ']' : '')));
            } catch (eM) {}

            try {
                if (L.isTrackMatte) { w('    NOTE:      this layer is used AS a matte'); }
            } catch (eIM) {}

            // Source text
            if (kind === 'TextLayer') {
                try {
                    var stProp = L.property('Source Text');
                    w('');
                    w('    -- Source Text --');
                    reportProp(stProp, '    ');
                } catch (eST) {}
            }

            // Transform
            w('');
            w('    -- Transform --');
            try {
                walkGroup(L.property('ADBE Transform Group'), '    ', 0);
            } catch (eT) {
                w('    (transform unreadable: ' + eT.toString() + ')');
            }

            // Masks
            try {
                var masks = L.property('ADBE Mask Parade');
                var mn = masks ? masks.numProperties : 0;
                w('');
                w('    -- Masks (' + mn + ') --');
                for (var mi = 1; mi <= mn; mi++) {
                    var mk = masks.property(mi);
                    var mode = '?';
                    try { mode = mk.maskMode; } catch (eMm) {}
                    var inv = '';
                    try { inv = mk.inverted ? ' inverted' : ''; } catch (eInv) {}
                    w('    + ' + mk.name + '  mode=' + mode + inv);
                    walkGroup(mk, '        ', 0);
                }
            } catch (eMk) {}

            // Shape contents
            if (INCLUDE_SHAPE_CONTENTS && kind === 'ShapeLayer') {
                try {
                    var contents = L.property('ADBE Root Vectors Group');
                    w('');
                    w('    -- Contents --');
                    walkGroup(contents, '    ', 0);
                } catch (eC) {
                    w('    (contents unreadable)');
                }
            }

            // Effects
            try {
                var fx = L.property('ADBE Effect Parade');
                var fn = fx ? fx.numProperties : 0;
                w('');
                w('    -- Effects (' + fn + ') --');
                for (var fi = 1; fi <= fn; fi++) {
                    var ef = fx.property(fi);
                    w('    + ' + ef.name + '   [' + ef.matchName + ']');
                }
                if (!fn) { w('    (none)'); }
            } catch (eF) {}
        }
    }

    w('');
    w('Layers reported: ' + layersReported);
    if (!layersReported) {
        w('');
        w('No layers matched LAYER_NAME_FILTER. Widen the filter or set it to [].');
    }

    // -----------------------------------------------------------------------
    // Write report
    // -----------------------------------------------------------------------

    var written = null;
    try {
        var base = proj.file
            ? proj.file.fsName.replace(/\.aepx?$/i, '')
            : (Folder.desktop.fsName + '/ae-project');
        var f = new File(base + '-inspect.txt');
        f.encoding = 'UTF-8';
        if (f.open('w')) { f.write(log.join('\n')); f.close(); written = f.fsName; }
    } catch (eW) {}

    alert('Inspection complete.\n\n' +
          comps.length + ' comp(s), ' + layersReported + ' layer(s) reported.\n\n' +
          (written ? 'Report:\n' + written
                   : 'Could not write the report file. Enable Preferences >\n' +
                     'Scripting & Expressions > "Allow Scripts to Write Files".'));

})();
