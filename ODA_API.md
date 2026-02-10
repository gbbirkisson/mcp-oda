# Oda API Data Structures

Findings from inspecting `__NEXT_DATA__` and REST API responses.

## Architecture

Oda uses Next.js with React Query. Server-side data is embedded in `<script id="__NEXT_DATA__">` as dehydrated React Query state:

```
__NEXT_DATA__.props.pageProps.dehydratedState.queries[]
  .queryKey  → ["queryName", ...params]
  .state.data → the actual data
```

## Product Search

**URL**: `https://oda.com/no/search/products/?q={query}&page={page}`

**Query key**: `["searchpageresponse", query, {page, size: 40, type: "product", filters: ""}]`

**Data shape**:
```json
{
  "type": "product",
  "attributes": {
    "items": 40,
    "page": 1,
    "hasMoreItems": true,
    "queryString": "melk",
    "requestTypes": [
      {"count": 220, "type": "product", "displayName": "Varer"},
      {"count": 301, "type": "recipe", "displayName": "Oppskrifter"}
    ]
  },
  "items": [...],
  "filters": [...]
}
```

**Product item** (`items[].type === "product"`):
```json
{
  "id": 132,
  "type": "product",
  "attributes": {
    "id": 132,
    "fullName": "Tine Fettfri Melk Skummet 0,1% fett",
    "name": "Tine Fettfri Melk Skummet",
    "nameExtra": "0,1% fett, 1 l",
    "brand": "TINE",
    "grossPrice": "20.80",
    "grossUnitPrice": "20.80",
    "unitPriceQuantityAbbreviation": "l",
    "currency": "NOK",
    "frontUrl": "https://oda.com/no/products/132-...",
    "absoluteUrl": "/no/products/132-...",
    "availability": {"isAvailable": true, "code": "available"},
    "discount": null,
    "images": [{"large": {"url": "..."}, "thumbnail": {"url": "..."}}]
  }
}
```

**Product filters** (flat):
```json
{
  "type": "filter",
  "contentType": "product",
  "name": "badges",
  "value": "is_organic",
  "displayValue": "Økologisk",
  "count": 29,
  "active": false,
  "queryParam": {"filters": "badges:is_organic", "type": "product"}
}
```

**Pagination**: `attributes.hasMoreItems` boolean. Increment `page` query param.

## Recipe Search

**URL**: `https://oda.com/no/recipes/all/?q={query}&page={page}&filters={filters}`

**Query key**: `["searchresponse", query, {type: "plain_recipe", page, size: 48, filters: ""}]`

**Recipe item** (`items[].type === "recipe"`):
```json
{
  "id": 608,
  "type": "recipe",
  "attributes": {
    "id": 608,
    "title": "Pizza Parma",
    "frontUrl": "/no/recipes/608-oda-pizza-parma/",
    "slugWithProvider": "oda-pizza-parma",
    "providerName": "Oda",
    "difficulty": "easy",
    "difficultyString": "Lett",
    "cookingDurationString": "30 min",
    "cookingDurationIso8601": "P0DT00H30M00S",
    "likeCount": 936,
    "numPortions": 4,
    "featureImageUrl": "https://images.oda.com/oppskrifter/...",
    "images": [{"large": {"url": "..."}, "thumbnail": {"url": "..."}}]
  }
}
```

**Recipe filters** (grouped):
```json
{
  "type": "filtergroup",
  "name": "diet",
  "displayName": "Kosthold",
  "items": [
    {
      "type": "filter",
      "contentType": "recipe",
      "name": "diet",
      "value": "43",
      "displayValue": "Vegetar",
      "count": 9,
      "queryParam": {"filters": "diet:43", "type": "recipe"}
    }
  ]
}
```

Filter IDs are formatted as `name:value` (e.g., `diet:43`).

## Recipe Detail

**URL**: `https://oda.com/no/recipes/{id}-{slug}/`

**Query key**: `["get-recipe-detail", recipeId, numPortions]`

**Data shape**:
```json
{
  "id": 608,
  "title": "Pizza Parma",
  "lead": "Description text...",
  "featureImageUrl": "https://...",
  "difficulty": "easy",
  "difficultyString": "Lett",
  "cookingDurationString": "30 min",
  "defaultNumPortions": 4,
  "minNumPortions": 1,
  "maxNumPortions": 99,
  "instructions": {
    "instructions": [
      {"ordering": 0, "text": "Step text..."},
      {"ordering": 1, "text": "Step text..."}
    ],
    "tips": []
  },
  "ingredientsDisplayList": [
    {
      "id": 6563,
      "title": "Pizzabunn, halvstekt",
      "displayQuantity": "1.000000",
      "displayUnit": "stk",
      "group": "",
      "hint": null
    }
  ],
  "ingredients": [
    {
      "id": 6563,
      "ingredient": {"id": 1378, "title": "Pizzabunn, halvstekt"},
      "portionQuantity": "0.250",
      "portionUnit": {"abbreviation": "stk", "name": "stykk"},
      "product": {
        "id": 36162,
        "fullName": "Staur Fjellbakeri Pizzabunn hvete ca 29cm 2stk",
        "grossPrice": "39.90"
      }
    }
  ]
}
```

## Cart

Cart data is **not in `__NEXT_DATA__`** — it's loaded client-side. Use the REST API directly.

### Get Cart

**GET** `https://oda.com/tienda-web-api/v1/cart/`

Headers: `Accept: application/json`, `Cookie`, `Origin: https://oda.com`, `Referer`, `X-CSRFToken`.

**Response** (snake_case):
```json
{
  "id": 0,
  "label_text": "30 varer",
  "product_quantity_count": 30,
  "display_price": "1068.40",
  "total_gross_amount": "1116.29",
  "groups": [
    {
      "id": "group-id",
      "title": "Group title",
      "group_type": "...",
      "items": [
        {
          "product": {
            "id": 9452,
            "full_name": "Avokado modnet Chile / Spania/ Marokko",
            "name": "Avokado modnet",
            "name_extra": "Chile / Spania/ Marokko, 2 stk",
            "gross_price": "29.90",
            "gross_unit_price": "14.95",
            "unit_price_quantity_abbreviation": "stk"
          },
          "item_id": 653938072,
          "quantity": 1,
          "display_price_total": "29.90"
        }
      ]
    }
  ]
}
```

### Add to Cart

**POST** `https://oda.com/tienda-web-api/v1/cart/items/`

Headers: `Accept: application/json`, `Content-Type: application/json`, `Cookie`, `Origin: https://oda.com`, `Referer`, `X-CSRFToken`.

```json
{"items": [{"product_id": 132, "quantity": 1}]}
```

Returns full cart response (same as GET).

### Remove from Cart

**POST** `https://oda.com/tienda-web-api/v1/cart/items/` with `quantity: 0`:

```json
{"items": [{"product_id": 132, "quantity": 0}]}
```

### Add Recipe to Cart

**POST** `https://oda.com/tienda-web-api/v1/cart/recipe/{recipeId}/`

```json
{"portions": 4}
```

## Authentication

### CSRF Token

All mutation requests require `X-CSRFToken` header. The token is in the `csrftoken` cookie, set on any page GET.

### Login

1. **GET** `https://oda.com/no/user/login/` to obtain CSRF token
2. **POST** `https://oda.com/no/user/login/` with `Content-Type: application/x-www-form-urlencoded`:
   - `email`, `password`, `csrfmiddlewaretoken` (= CSRF token)
   - Include `Referer: https://oda.com/no/user/login/`
   - Successful login returns 302 redirect

### Check User

The `"user"` dehydrated query is present on all pages (when authenticated):

```json
{
  "hashedUserId": "...",
  "email": "user@example.com",
  "firstName": "Dude",
  "lastName": "Dudeson",
  "isProfileComplete": true
}
```

## Important Notes

- Product search uses **camelCase** field names (from React/Next.js)
- Cart REST API uses **snake_case** field names (Django backend)
- The `425 Too Early` status is returned when the server is overloaded
- Pagination is page-number based (`?page=2`), not cursor-based
- All requests need the `csrftoken` cookie — obtained from any GET request
