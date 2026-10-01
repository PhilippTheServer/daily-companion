import type { FoodOut, RecipeOut } from '../app/core/api/types';

const nutrients = {
  kcal: 0,
  protein_g: 0,
  carbs_g: 0,
  fat_g: 0,
  fiber_g: 0,
  sugar_g: 0,
  salt_g: 0,
  fluid_ml: 0,
};

export function food(overrides: Partial<FoodOut> = {}): FoodOut {
  return {
    id: 'food-1',
    name: 'Skyr',
    brand: 'Arla',
    barcode: '4001234',
    kind: 'food',
    source: 'off',
    unit_name: null,
    unit_grams: null,
    pack_grams: 450,
    archived: false,
    version_id: 'fv-2',
    per_100: {
      kcal: 63,
      protein_g: 11,
      carbs_g: 4,
      fat_g: 0.2,
      fiber_g: null,
      sugar_g: 4,
      salt_g: 0.1,
    },
    versions: 2,
    ...overrides,
  };
}

export function recipe(overrides: Partial<RecipeOut> = {}): RecipeOut {
  return {
    id: 'recipe-1',
    name: 'Overnight oats',
    version_id: 'rv-1',
    serves: 2,
    steps: ['Mix', 'Wait overnight'],
    items: [
      {
        food_id: 'food-1',
        name: 'Skyr',
        grams: 250,
        unit_name: null,
        unit_grams: null,
        nutrients: { ...nutrients, kcal: 158 },
      },
      {
        food_id: 'food-2',
        name: 'Oats',
        grams: 80,
        unit_name: null,
        unit_grams: null,
        nutrients: { ...nutrients, kcal: 297 },
      },
    ],
    totals: { ...nutrients, kcal: 455, protein_g: 38 },
    per_portion: { ...nutrients, kcal: 227.5, protein_g: 19 },
    note: null,
    archived: false,
    versions: 1,
    ...overrides,
  };
}
