export interface SearchResult {
  index: number;
  name: string;
  subtitle: string;
  price: number;
  relative_price: number;
  relative_price_unit: string;
}

export interface ProductPage {
  page_url: string;
  items: SearchResult[];
}

export interface CartItem {
  index: number;
  name: string;
  subtitle: string;
  quantity: number;
  price: number;
  relative_price: number;
  relative_price_unit: string;
}

export interface Recipe {
  index: number;
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
}

export interface RecipeDetail {
  name: string;
  description: string;
  ingredients: string[];
  instructions: string[];
  image_url?: string;
}
