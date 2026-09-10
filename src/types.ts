export interface SearchResult {
  id: number;
  name: string;
  subtitle: string;
  price: number;
  relative_price: number;
  relative_price_unit: string;
}

export interface ProductPage {
  page_url: string;
  items: SearchResult[];
  has_more: boolean;
}

export interface CartItem {
  id: number;
  name: string;
  subtitle: string;
  quantity: number;
  price: number;
  relative_price: number;
  relative_price_unit: string;
}

export interface Recipe {
  id: number;
  name: string;
  image_url?: string;
  duration?: string;
  difficulty?: string;
}

export interface RecipeFilter {
  id: string;
  name: string;
  count: number;
  category: string;
}

export interface RecipePage {
  page_url: string;
  filters: RecipeFilter[];
  items: Recipe[];
  has_more: boolean;
}

export interface RecipeIngredient {
  title: string;
  quantity: number;
  unit: string;
  /** Purchasable product behind the ingredient, when Oda maps one. */
  product_id?: number;
  /** Cart quantity per portion, as used when adding the recipe to the cart. */
  portion_quantity?: number;
}

export interface RecipeDetail {
  name: string;
  description: string;
  ingredients: string[];
  /**
   * Structured ingredients with product mapping. Absent when the recipe was
   * loaded from the JSON-LD fallback, which carries no product IDs.
   */
  ingredient_items?: RecipeIngredient[];
  instructions: string[];
  image_url?: string;
}

export interface SavedList {
  id: number;
  title: string;
  description: string;
  number_of_products: number;
  number_of_items: number;
  total_quantity: number;
  last_bought_date?: string;
  url: string;
}

/** Normalized product fields shared by list items and recommendations. */
export interface ProductSummary {
  id: number;
  name: string;
  subtitle: string;
  price: number;
  relative_price: number;
  relative_price_unit: string;
}

export interface SavedListItem extends ProductSummary {
  quantity: number;
}

export type CartRecommendation = ProductSummary;

export interface SavedListDetail extends SavedList {
  items: SavedListItem[];
}
