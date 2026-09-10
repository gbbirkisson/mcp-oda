export interface SearchResult {
  id: number;
  name: string;
  subtitle: string;
  price: number;
  relative_price: number;
  relative_price_unit: string;
  brand?: string;
  currency?: string;
  is_available?: boolean;
  /** Only set when the product is not plainly available. */
  availability_code?: string;
  discount?: {
    undiscounted_price: number;
    description?: string;
    /** Max units at the discounted price, when the campaign caps it. */
    maximum_quantity?: number;
  };
  image_url?: string;
}

export type SearchFilter = RecipeFilter;

export interface ProductPage {
  page_url: string;
  items: SearchResult[];
  has_more: boolean;
  /** Total matching products across all pages. */
  total_count?: number;
  /** Matches per content type (product, recipe, ...). */
  type_counts?: Record<string, number>;
  filters?: SearchFilter[];
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
