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

export interface DeliverySlot {
  id: number;
  starts_at: string;
  ends_at: string;
  /** Ordering deadline for this slot. */
  deadline: string;
  /** Numeric price parsed from the display string, when parseable. */
  price: number | null;
  price_label: string;
  is_available: boolean;
  is_cheapest?: boolean;
  /** Why the slot is unavailable, when Oda says so (often cart-dependent). */
  unavailable_description?: string;
}

export interface DeliveryDay {
  /** Local calendar date (YYYY-MM-DD) in the store's time zone. */
  date: string;
  slots: DeliverySlot[];
}

export interface DeliverySlots {
  time_zone: string;
  days: DeliveryDay[];
  /** Cart-dependent warnings, e.g. items not purchasable before a date. */
  validation_messages: string[];
}
