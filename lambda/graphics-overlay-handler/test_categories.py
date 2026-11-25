"""Category contract between the classifier, the Mimir dropdown and the overlay.

The classifier (classify-category-handler) and the producer dropdown
(register-mimir-integrations) both emit one of a fixed list of category
names. Each must reach the overlay as itself, not as the BREAKING NEWS
fallback, and must have a dropdown index and an accent colour. Templates that
carry per-category sidebar artwork are checked too: each index needs a sidebar
whose ticker text repeats exactly, or the persistent variant loses its short
seamless loop (the "NEWTAINMENT" typo in the station template did this).

Run: python -m pytest lambda/graphics-overlay-handler/test_categories.py
"""
import copy
import glob
import importlib.util
import json
import os
import re
import sys
from unittest import mock

import pytest

sys.modules.setdefault('boto3', mock.MagicMock())
HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    'graphics_overlay_index_categories', os.path.join(HERE, 'index.py'))
index = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(index)

LAMBDA_DIR = os.path.dirname(HERE)
TEMPLATES_DIR = os.path.join(LAMBDA_DIR, '..', 'graphics', 'templates')


def _js_string_array(path, const_name):
    src = open(path, encoding='utf-8').read()
    m = re.search(r'const\s+%s\s*=\s*\[(.*?)\];' % const_name, src, re.S)
    assert m, f'{const_name} not found in {path}'
    return re.findall(r"'([^']+)'", m.group(1))


CLASSIFIER_CATEGORIES = _js_string_array(
    os.path.join(LAMBDA_DIR, 'classify-category-handler', 'index.js'), 'CATEGORIES')
MIMIR_OPTIONS = _js_string_array(
    os.path.join(LAMBDA_DIR, 'register-mimir-integrations', 'index.js'), 'GFX_TEMPLATE_OPTIONS')


def test_classifier_and_mimir_dropdown_lists_match():
    assert CLASSIFIER_CATEGORIES
    assert CLASSIFIER_CATEGORIES == MIMIR_OPTIONS


@pytest.mark.parametrize('category', CLASSIFIER_CATEGORIES)
def test_every_category_maps_without_fallback(category):
    assert index.normalise_category(category) == category
    assert category in index.CATEGORY_DROPDOWN
    assert category in index.CATEGORY_COLORS


def _sidebar_templates():
    paths = sorted(glob.glob(os.path.join(TEMPLATES_DIR, '*.json')))
    out = []
    for p in paths:
        data = json.load(open(p, encoding='utf-8'))
        if index._dropdown_value(data, 'sidebar control', 'Choose News Type') is not None:
            out.append(pytest.param(p, id=os.path.basename(p)))
    return out


SIDEBAR_TEMPLATES = _sidebar_templates()


@pytest.mark.skipif(not SIDEBAR_TEMPLATES,
                    reason='no template in graphics/templates has per-category sidebars '
                           '(customer templates are git-ignored)')
@pytest.mark.parametrize('path', SIDEBAR_TEMPLATES or [None])
@pytest.mark.parametrize('category', CLASSIFIER_CATEGORIES)
def test_sidebar_template_loops_for_every_category(path, category):
    data = json.load(open(path, encoding='utf-8'))
    index.set_category_dropdown(data, category)
    assert index.snap_scrollers_to_pitch(copy.deepcopy(data), 90) is not None, (
        f'{category}: no visible sidebar ticker repeats exactly; check its text for typos')
