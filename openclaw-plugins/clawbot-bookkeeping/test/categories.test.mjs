import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeSubcategory,
  primaryCategoryForSubcategory,
} from '../categories.mjs';

test('normalizes meal aliases to the formal subcategory', () => {
  assert.equal(normalizeSubcategory('食品酒水', '午饭'), '早午晚餐');
});

test('finds the primary category for a formal subcategory', () => {
  assert.equal(primaryCategoryForSubcategory('超市购物'), '食品酒水');
});

test('rejects a subcategory under the wrong parent', () => {
  assert.throws(
    () => normalizeSubcategory('行车交通', '早午晚餐'),
    /二级分类必须是“行车交通”下的正式分类名称。/u,
  );
});
