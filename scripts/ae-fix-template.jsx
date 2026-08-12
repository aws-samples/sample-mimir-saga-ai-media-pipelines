/**
 * ae-fix-template.jsx
 *
 * Small targeted repair script for graphics template projects. Two jobs:
 *
 *   1. Clear the "Inverted" flag on masks (an inverted reveal mask hides the
 *      text instead of revealing it)
 *   2. Copy transform values for a layer from a known-good comp to the same
 *      layer in other comps — for fixing a value that was frozen wrong
 *
 * Both are useful after baking expressions: baking captures whatever the
 * expression evaluated to at the current time, so a layer whose in-point had
 * not started yet can end up with a nonsense position. Copying the value from
 * a comp that came out right is faster than re-deriving it.
 *
 * Copying works because these box layers are PARENTED to their text layer, so
 * Position is an offset from the parent rather than an absolute comp position.
 * The same offset is therefore valid in every comp.
 *
 * Usage:
 *   1. Open the project
 *   2. Edit the CONFIG block
 *   3. Run with DRY_RUN = true, read the report, then set it false
 *
 * Runs inside one undo group. ExtendScript (ES3).
 */

(function aeFixTemplate() {

    // =======================================================================
    // CONFIG
    // =======================================================================

    var DRY_RUN = true;

    // ---- Job 0: remove masks entirely ------------------------------------
    // Layers whose name contains one of these have ALL their masks deleted.
    // Use this to strip a half-finished reveal so every comp behaves the same.
    // Empty array = skip this job.
    var REMOVE_MASKS_ON = [];

    // ---- Job 1: clear Inverted on masks ---------------------------------
    // Layers whose name contains one of these have every mask un-inverted.
    // Empty array = skip this job.
    var UNINVERT_MASKS_ON = [
        'Location/Courtesy',
        'Category Label'
    ];

    // Also force mask mode to Add while we are here (an inverted reveal is
    // often paired with a Subtract mode). Set false to leave modes alone.
    var FORCE_MASK_MODE_ADD = true;

    // ---- Job 2: copy transform values between comps ----------------------
    // Empty COPY_LAYERS = skip this job.
    var COPY_FROM_COMP = 'graphics-overlay-1080x1350-4x5';
    var COPY_TO_COMPS  = ['graphics-overlay-1080x1080-1x1'];
    var COPY_LAYERS    = ['Category Label-TextBox', 'location/courtesy-TextBox'];
    var COPY_PROPS     = ['Position', 'Anchor Point'];

    // =======================================================================
    // Helpers
    // =======================================================================

    var log = [];
    var actions = 0;

    function w(s) { log.push(s === undefined ? '' : String(s)); }
    function hr(t) {
        w('');
        w('---- ' + t + ' ----------------------------------------');
    }
    function act(s) {
        actions++;
        w('  ' + (DRY_RUN ? '[would] ' : '[done]  ') + s);
    }
    function note(s) { w('  ' + s); }
    function lower(s) { return String(s === undefined ? '' : s).toLowerCase(); }
    function trim(s) {
        return String(s === undefined || s === null ? '' : s).replace(/^\s+|\s+$/g, '');
    }
    function matchesAny(s, list) {
        var h = lower(s);
        for (var a = 0; a < list.length; a++) {
            if (h.indexOf(lower(list[a])) !== -1) { return true; }
        }
        return false;
    }
    function round(n) { return Math.round(n * 1000) / 1000; }
    function fmt(v) {
        if (v === undefined || v === null) { return '(none)'; }
        if (typeof v === 'number') { return String(round(v)); }
        try {
            if (v.length !== undefined) {
                var p = [];
                for (var a = 0; a < v.length; a++) { p.push(round(v[a])); }
                return '[' + p.join(', ') + ']';
            }
        } catch (e) {}
        return String(v);
    }

    function compByName(name) {
        for (var a = 1; a <= app.project.numItems; a++) {
            var it = app.project.item(a);
            if (it instanceof CompItem && trim(it.name) === trim(name)) { return it; }
        }
        return null;
    }

    function layerByName(comp, name) {
        for (var a = 1; a <= comp.numLayers; a++) {
            if (trim(comp.layer(a).name) === trim(name)) { return comp.layer(a); }
        }
        return null;
    }

    // =======================================================================
    // Guards
    // =======================================================================

    if (!app.project) { alert('No project is open.'); return; }
    var proj = app.project;

    w('After Effects Template Fixer');
    w('Mode: ' + (DRY_RUN ? 'DRY RUN — nothing will be modified' : '*** APPLYING CHANGES ***'));
    w('Project: ' + (proj.file ? proj.file.name : '(unsaved)'));

    if (!DRY_RUN) { app.beginUndoGroup('Fix graphics template'); }

    try {

        // ---- Job 0: remove masks ------------------------------------------

        if (REMOVE_MASKS_ON.length) {
            hr('REMOVE MASKS');
            for (var rci = 1; rci <= proj.numItems; rci++) {
                var rc = proj.item(rci);
                if (!(rc instanceof CompItem)) { continue; }

                for (var rli = 1; rli <= rc.numLayers; rli++) {
                    var RL = rc.layer(rli);
                    if (!matchesAny(RL.name, REMOVE_MASKS_ON)) { continue; }

                    var rmasks = null;
                    try { rmasks = RL.property('ADBE Mask Parade'); } catch (eRm) { rmasks = null; }
                    var rmn = 0;
                    if (rmasks) { try { rmn = rmasks.numProperties; } catch (eRn) { rmn = 0; } }
                    if (!rmn) { continue; }

                    // backwards: removing shifts indices
                    for (var rmi = rmn; rmi >= 1; rmi--) {
                        var rmk = rmasks.property(rmi);
                        var rmName = '(mask)';
                        try { rmName = rmk.name; } catch (eRnm) {}
                        act('remove mask: ' + rc.name + ' / ' + RL.name + ' / ' + rmName);
                        if (!DRY_RUN) {
                            try { rmk.remove(); }
                            catch (eRr) { note('    failed: ' + eRr.toString()); }
                        }
                    }
                }
            }
            if (!actions) { note('(no masks found on matching layers)'); }
        }

        // ---- Job 1: un-invert masks --------------------------------------

        if (UNINVERT_MASKS_ON.length) {
            hr('CLEAR INVERTED ON MASKS');
            for (var ci = 1; ci <= proj.numItems; ci++) {
                var c = proj.item(ci);
                if (!(c instanceof CompItem)) { continue; }

                for (var li = 1; li <= c.numLayers; li++) {
                    var L = c.layer(li);
                    if (!matchesAny(L.name, UNINVERT_MASKS_ON)) { continue; }

                    var masks = null;
                    try { masks = L.property('ADBE Mask Parade'); } catch (eM) { masks = null; }
                    var mn = 0;
                    if (masks) { try { mn = masks.numProperties; } catch (eN) { mn = 0; } }
                    if (!mn) { continue; }

                    for (var mi = 1; mi <= mn; mi++) {
                        var mk = masks.property(mi);

                        var inv = false;
                        try { inv = mk.inverted; } catch (eI) {}
                        if (inv) {
                            act('un-invert: ' + c.name + ' / ' + L.name + ' / ' + mk.name);
                            if (!DRY_RUN) { mk.inverted = false; }
                        }

                        if (FORCE_MASK_MODE_ADD) {
                            var mode = null;
                            try { mode = mk.maskMode; } catch (eMo) {}
                            if (mode !== null && mode !== MaskMode.ADD) {
                                act('mask mode -> Add: ' + c.name + ' / ' + L.name +
                                    ' / ' + mk.name + '  (was ' + mode + ')');
                                if (!DRY_RUN) { mk.maskMode = MaskMode.ADD; }
                            }
                        }
                    }
                }
            }
            if (!actions) { note('(no inverted masks found)'); }
        }

        // ---- Job 2: copy transform values --------------------------------

        if (COPY_LAYERS.length) {
            hr('COPY TRANSFORM VALUES BETWEEN COMPS');

            var srcComp = compByName(COPY_FROM_COMP);
            if (!srcComp) {
                note('SKIPPED — source comp not found: ' + COPY_FROM_COMP);
            } else {
                note('source comp: ' + srcComp.name);

                for (var ti = 0; ti < COPY_TO_COMPS.length; ti++) {
                    var dstComp = compByName(COPY_TO_COMPS[ti]);
                    if (!dstComp) {
                        note('SKIPPED — target comp not found: ' + COPY_TO_COMPS[ti]);
                        continue;
                    }
                    note('');
                    note('target comp: ' + dstComp.name);

                    for (var lyi = 0; lyi < COPY_LAYERS.length; lyi++) {
                        var lname = COPY_LAYERS[lyi];
                        var srcL = layerByName(srcComp, lname);
                        var dstL = layerByName(dstComp, lname);

                        if (!srcL) { note('  no such layer in source: ' + lname); continue; }
                        if (!dstL) { note('  no such layer in target: ' + lname); continue; }

                        // Sanity: same parent relationship?
                        var sp = '', dp = '';
                        try { sp = srcL.parent ? srcL.parent.name : '(none)'; } catch (e1) {}
                        try { dp = dstL.parent ? dstL.parent.name : '(none)'; } catch (e2) {}
                        if (trim(sp) !== trim(dp)) {
                            note('  WARNING ' + lname + ': parent differs (source "' + sp +
                                 '" vs target "' + dp + '"). Copied values may not line up.');
                        }

                        for (var pi = 0; pi < COPY_PROPS.length; pi++) {
                            var pname = COPY_PROPS[pi];
                            var sProp = null, dProp = null;
                            try { sProp = srcL.property('ADBE Transform Group').property(pname); } catch (e3) {}
                            try { dProp = dstL.property('ADBE Transform Group').property(pname); } catch (e4) {}
                            if (!sProp || !dProp) {
                                note('  ' + lname + ' / ' + pname + ': property not found');
                                continue;
                            }

                            var sVal = null, dVal = null;
                            try { sVal = sProp.value; } catch (e5) {}
                            try { dVal = dProp.value; } catch (e6) {}

                            // Do not clobber animation or a live expression.
                            var nk = 0;
                            try { nk = dProp.numKeys || 0; } catch (e7) {}
                            if (nk) {
                                note('  SKIPPED (keyframed): ' + lname + ' / ' + pname);
                                continue;
                            }
                            var hasExpr = false;
                            try {
                                hasExpr = !!(dProp.canSetExpression && dProp.expression &&
                                             dProp.expressionEnabled);
                            } catch (e8) {}
                            if (hasExpr) {
                                note('  SKIPPED (live expression): ' + lname + ' / ' + pname);
                                continue;
                            }

                            act(lname + ' / ' + pname + ':  ' + fmt(dVal) + '  ->  ' + fmt(sVal));
                            if (!DRY_RUN) {
                                try { dProp.setValue(sVal); }
                                catch (e9) { note('    failed: ' + e9.toString()); }
                            }
                        }
                    }
                }
            }
        }

    } catch (eMain) {
        w('');
        w('*** ABORTED: ' + eMain.toString() +
          (eMain.line ? '  (line ' + eMain.line + ')' : ''));
    }

    if (!DRY_RUN) {
        try { app.endUndoGroup(); } catch (eG) {}
    }

    hr('SUMMARY');
    w('  ' + actions + ' action(s) ' + (DRY_RUN ? 'planned' : 'applied'));

    var written = null;
    try {
        var base = proj.file
            ? proj.file.fsName.replace(/\.aepx?$/i, '')
            : (Folder.desktop.fsName + '/ae-project');
        var f = new File(base + '-fix' + (DRY_RUN ? '-dryrun' : '') + '.txt');
        f.encoding = 'UTF-8';
        if (f.open('w')) { f.write(log.join('\n')); f.close(); written = f.fsName; }
    } catch (eW) {}

    alert((DRY_RUN ? 'DRY RUN complete — nothing was modified.\n\n'
                   : 'Fixes applied.\n\n') +
          actions + ' action(s) ' + (DRY_RUN ? 'planned' : 'applied') + '.\n\n' +
          (written ? 'Report:\n' + written : 'Could not write the report file.') +
          (DRY_RUN ? '\n\nReview it, then set DRY_RUN = false to apply.' : ''));

})();
