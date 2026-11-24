"""Unit tests for the persistent-loop and layer-split helpers in index.py.

Run: python -m pytest lambda/graphics-overlay-handler/test_index.py
"""
import importlib.util
import os
import sys
from unittest import mock

sys.modules.setdefault('boto3', mock.MagicMock())
_spec = importlib.util.spec_from_file_location(
    'graphics_overlay_index', os.path.join(os.path.dirname(__file__), 'index.py'))
index = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(index)


def _scroller(text, y0, y1, seg=450):
    return {
        'ty': 5, 'nm': 'ticker', 'ip': 0, 'op': seg + 1, 'st': 0,
        'ks': {'r': {'a': 0, 'k': -90},
               'p': {'a': 1, 'k': [
                   {'t': 0, 's': [376, y0, 0], 'to': [0, 0, 0], 'ti': [0, 0, 0]},
                   {'t': seg, 's': [376, y1, 0]}]}},
        't': {'d': {'k': [{'s': {'t': text, 's': 100, 'f': 'F', 'tr': 0}, 't': 0}]}},
    }


def _template(travel, category_index=2, selected=2):
    """Root -> 'sidebar' precomp tiling a 15s scroller comp, like the station toolkit."""
    seg = 450
    instances = [{'ty': 0, 'nm': 'inst', 'refId': 'sec15', 'ip': i * seg, 'op': (i + 1) * seg,
                  'st': i * seg, 'ks': {}} for i in range(4)]
    expr = f"myIndex = {category_index};\n$bm_rt = dropdown == myIndex ? 100 : 0;"
    return {
        'fr': 29.97, 'ip': 0, 'op': 1800, 'w': 100, 'h': 100,
        'fonts': {'list': [{'fName': 'F', 'fFamily': 'Fam', 'fStyle': 'Bold'}]},
        # 'A' and 'B' and ' ' are 50 wide at size 100 -> "AB  " pitch 200
        'chars': [{'ch': c, 'fFamily': 'Fam', 'style': 'Bold', 'w': 50} for c in 'AB '],
        'assets': [
            {'id': 'sec15', 'layers': [_scroller('AB  ' * 20, 5000, 5000 - travel)]},
            {'id': 'min2', 'layers': instances},
        ],
        'layers': [
            {'ty': 3, 'nm': 'sidebar control', 'ks': {},
             'ef': [{'nm': 'Choose News Type', 'ef': [{'nm': 'Menu', 'v': {'k': selected}}]}]},
            {'ty': 0, 'nm': 'sidebar_x - 2min', 'refId': 'min2', 'ip': 0, 'op': 1800, 'st': 0,
             'ks': {'o': {'a': 0, 'k': 100, 'x': expr}}},
        ],
    }


def _end_y(data):
    return data['assets'][0]['layers'][0]['ks']['p']['k'][1]['s'][1]


def test_snaps_travel_to_whole_pitches_and_returns_loop():
    data = _template(travel=601)            # 3.005 pitches of 200
    assert index.snap_scrollers_to_pitch(data, 90) == 150
    assert abs((5000 - _end_y(data)) - 600) < 1e-9


def test_loop_is_full_segment_when_pitches_do_not_divide_it():
    data = _template(travel=1400)           # 7 pitches -> 450 / gcd(450, 7)
    assert index.snap_scrollers_to_pitch(data, 90) == 450


def test_deselected_sidebar_is_ignored():
    data = _template(travel=601, category_index=3, selected=2)
    before = _end_y(data)
    assert index.snap_scrollers_to_pitch(data, 90) is None
    assert _end_y(data) == before           # untouched on fallback


def test_non_repeating_text_falls_back():
    data = _template(travel=601)
    data['assets'][0]['layers'][0]['t']['d']['k'][0]['s']['t'] = 'AB  AB  BA  AB  '
    assert index.snap_scrollers_to_pitch(data, 90) is None


def test_category_badge_is_in_text_group():
    for name in ('BREAKING NEWS', 'BREAKING NEWS ', 'BREAKING NEWS-TextBox',
                 'BREAKING NEWS-TextBox 2', 'Category Label', 'Category Label-TextBox'):
        assert index._is_text_layer(name)
        assert not index._is_persistent_layer(name)
    for name in ('logo_wpde_abc15.png', 'logo_placeholder', 'Location/Courtesy ',
                 'sidebar_breaking-news - 2min'):
        assert index._is_persistent_layer(name)
        assert not index._is_text_layer(name)
