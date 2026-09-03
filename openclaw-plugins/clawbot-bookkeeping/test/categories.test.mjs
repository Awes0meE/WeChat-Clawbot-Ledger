import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CATEGORY_DEFINITIONS,
  PRIMARY_CATEGORIES,
  SUBCATEGORIES,
  normalizeSubcategory,
  primaryCategoryForSubcategory,
} from '../categories.mjs';

test('exports the authoritative, immutable 11-primary and 45-secondary catalog', () => {
  assert.deepEqual(CATEGORY_DEFINITIONS, {
    食品酒水: ['早午晚餐', '烟酒茶', '水果零食', '饮料甜品', '超市购物'],
    行车交通: ['公共交通', '打车租车', '私家车费用'],
    居家物业: ['日常用品', '水电煤气', '房租', '物业管理', '维修保养'],
    交流通讯: ['座机费', '手机费', '上网费', '邮寄费'],
    衣服饰品: ['衣服裤子', '鞋帽包包', '化妆饰品'],
    休闲娱乐: ['运动健身', '交际聚会', '休闲玩乐', '宠物宝贝', '旅游度假'],
    医疗保健: ['药品费', '保健费', '美容费', '治疗费'],
    学习进修: ['数码装备', '书报杂志', '培训进修'],
    人情往来: ['送礼请客', '孝敬长辈', '还人钱物', '慈善捐助'],
    金融保险: ['银行手续', '投资亏损', '按揭还款', '消费税收', '利息支出', '赔偿罚款'],
    其他杂项: ['其他支出', '意外丢失', '烂账损失'],
  });
  assert.equal(PRIMARY_CATEGORIES.length, 11);
  assert.equal(SUBCATEGORIES.length, 45);
  assert.equal(new Set(SUBCATEGORIES).size, SUBCATEGORIES.length);
  assert.ok(Object.isFrozen(CATEGORY_DEFINITIONS));
  assert.ok(Object.values(CATEGORY_DEFINITIONS).every(Object.isFrozen));
  assert.ok(Object.isFrozen(PRIMARY_CATEGORIES));
  assert.ok(Object.isFrozen(SUBCATEGORIES));
});

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
