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

export interface CartLine extends CartItem {
  /** Cart line id, distinct from the product id. */
  item_id: number;
  /** Total price for the line (quantity x price, weight-adjusted by Oda). */
  line_total: number;
  /** Group heading (e.g. a recipe name) when the item belongs to a group. */
  group_title?: string;
  group_type?: string;
}

export interface Cart {
  /** Human-readable cart label, e.g. "30 varer". */
  label_text: string;
  product_quantity_count: number;
  /** What the cart costs at current prices. */
  display_price: number;
  total_gross_amount: number;
  items: CartLine[];
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

export interface RecipeDetail {
  name: string;
  description: string;
  ingredients: string[];
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
