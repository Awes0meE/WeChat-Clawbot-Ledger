export const CATEGORY_DEFINITIONS = Object.freeze({
  食品酒水: Object.freeze(['早午晚餐', '烟酒茶', '水果零食', '饮料甜品', '超市购物']),
  行车交通: Object.freeze(['公共交通', '打车租车', '私家车费用']),
  居家物业: Object.freeze(['日常用品', '水电煤气', '房租', '物业管理', '维修保养']),
  交流通讯: Object.freeze(['座机费', '手机费', '上网费', '邮寄费']),
  衣服饰品: Object.freeze(['衣服裤子', '鞋帽包包', '化妆饰品']),
  休闲娱乐: Object.freeze(['运动健身', '交际聚会', '休闲玩乐', '宠物宝贝', '旅游度假']),
  医疗保健: Object.freeze(['药品费', '保健费', '美容费', '治疗费']),
  学习进修: Object.freeze(['数码装备', '书报杂志', '培训进修']),
  人情往来: Object.freeze(['送礼请客', '孝敬长辈', '还人钱物', '慈善捐助']),
  金融保险: Object.freeze(['银行手续', '投资亏损', '按揭还款', '消费税收', '利息支出', '赔偿罚款']),
  其他杂项: Object.freeze(['其他支出', '意外丢失', '烂账损失']),
});

export const PRIMARY_CATEGORIES = Object.freeze(Object.keys(CATEGORY_DEFINITIONS));
export const SUBCATEGORIES = Object.freeze(Object.values(CATEGORY_DEFINITIONS).flat());
export const CATEGORY_GUIDE = PRIMARY_CATEGORIES
  .map((primaryCategory) => `${primaryCategory}: ${CATEGORY_DEFINITIONS[primaryCategory].join('、')}`)
  .join('\n');

const SUBCATEGORY_ALIASES = new Map([
  ['餐饮', '早午晚餐'],
  ['早餐', '早午晚餐'],
  ['午餐', '早午晚餐'],
  ['晚餐', '早午晚餐'],
  ['早饭', '早午晚餐'],
  ['午饭', '早午晚餐'],
  ['晚饭', '早午晚餐'],
  ['正餐', '早午晚餐'],
]);

const PRIMARY_BY_SUBCATEGORY = new Map(
  Object.entries(CATEGORY_DEFINITIONS)
    .flatMap(([primaryCategory, subcategories]) => subcategories.map((subcategory) => [subcategory, primaryCategory])),
);

export function normalizeSubcategory(primaryCategory, value) {
  const normalized = SUBCATEGORY_ALIASES.get(value) ?? value;
  if (!CATEGORY_DEFINITIONS[primaryCategory]?.includes(normalized)) {
    throw new Error(`二级分类必须是“${primaryCategory}”下的正式分类名称。`);
  }
  return normalized;
}

export function primaryCategoryForSubcategory(subcategory) {
  return PRIMARY_BY_SUBCATEGORY.get(subcategory);
}
