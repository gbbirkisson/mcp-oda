# Oda API Data Structures

Findings from inspecting page hydration data and REST API responses.

## Architecture

Oda uses Next.js with React Query. Server-side data reaches the browser as
dehydrated React Query state, but **where** that state lives changed when Oda
migrated from the Next.js Pages Router to the App Router.

### Current layout (App Router)

There is no `__NEXT_DATA__` script tag. The state is embedded in the RSC flight
payload, which Next.js streams as a series of `self.__next_f.push` calls:

```html
<script>(self.__next_f=self.__next_f||[]).push([0])</script>
<script>self.__next_f.push([1,"1:\"$Sreact.fragment\"\n2:I[339756,...]\n..."])</script>
```

Each `push([1, "<chunk>"])` carries a slice of the payload. Chunks may split
anywhere — even mid-token — so they are only meaningful once concatenated in
order.

The joined payload is a newline-separated list of rows (`<id>:<json>`). React
Query state appears inside `HydrationBoundary` rows:

```
48:["$","$L30",null,{"state":{"mutations":[],"queries":[ ... ]}}]
```

A page renders **several** boundaries — global chrome carries `user` and
`apiV1UserConfiguration`, page content carries `mixedSearch` or
`recipeDetailApi` — so all `queries` arrays must be collected and merged, not
just the first.

Each query entry has the familiar shape:

```
.queryKey   → [{_id: "queryName", ...params}]   (older pages used ["queryName", ...])
.state.data → the actual data
```

### Legacy layout (Pages Router)

Older pages embedded everything in one script tag:

```
__NEXT_DATA__.props.pageProps.dehydratedState.queries[]
```

`extractNextData()` in `src/oda-client.ts` reads whichever layout is present and
normalises both to the legacy `props.pageProps.dehydratedState` shape, so the
rest of the client is layout-agnostic.

### Inspecting a page

The `dump` command prints the query keys found on a page and the normalised
hydration data, which is the quickest way to re-check these structures:

```bash
mcp-oda dump "https://oda.com/no/search/products/?q=melk"
```

```
=== Query keys (5) ===
tiendaWebMegamenu
apiV1UserConfiguration
user
onboardingUrl
mixedSearch
```

## Product Search

**URL**: `https://oda.com/no/search/products/?q={query}&page={page}`

**Query key**: `[{_id: "mixedSearch", query: {q, page, size: 42, type: "product", filters: "", "only-available": false}}]`

**Data shape**:
```json
{
  "type": "product",
  "attributes": {
    "items": 42,
    "page": 1,
    "hasMoreItems": true,
    "queryString": "melk",
    "requestTypes": [
      {"count": 562, "type": "product", "displayName": "Varer"},
      {"count": 308, "type": "recipe", "displayName": "Oppskrifter"}
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

**Query key**: `[{_id: "mixedSearch", query: {q, type: "plain_recipe", page, size: 48, filters: ""}}]`

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

**Query key**: `[{_id: "recipeDetailApi", path: {recipe_id}, query: {portions}}]`

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
      "displayQuantity": "1.000",
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

Cart data is **not in the page hydration data** — it's loaded client-side. Use the REST API directly.

All cart mutations are JSON (`Content-Type: application/json`) and require the
`X-CSRFToken` header plus session cookies.

### Get Cart

**GET** `https://oda.com/api/v1/cart/`

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

**POST** `https://oda.com/api/v1/cart/items/`

Headers: `Accept: application/json`, `Content-Type: application/json`, `Cookie`, `Origin: https://oda.com`, `Referer`, `X-CSRFToken`.

```json
{"items": [{"product_id": 132, "quantity": 1}]}
```

Returns full cart response (same as GET).

### Remove from Cart

**POST** `https://oda.com/api/v1/cart/items/`

`quantity` is a **relative delta**, not an absolute count — send a negative
number to remove:

```json
{"items": [{"product_id": 132, "quantity": -1}]}
```

### Clear Cart

**POST** `https://oda.com/api/v1/cart/clear/` with an empty body (`{}`).

### Add Recipe to Cart

There is no single "add recipe" endpoint. The recipe is expanded client-side:
fetch the recipe detail, take each `ingredients[]` entry that has a
`product.id`, and scale `portionQuantity` by the requested portions.

**POST** `https://oda.com/api/v1/cart/items/?group_by=recipes`

```json
{
  "items": [
    {
      "product_id": 36162,
      "quantity": 1,
      "from_recipe_id": 608,
      "from_recipe_portions": 4
    }
  ]
}
```

`from_recipe_id` / `from_recipe_portions` are what let Oda group the items as a
recipe in the cart — and what makes removal by recipe possible.

### Remove Recipe from Cart

**POST** `https://oda.com/api/v1/cart/items/?group_by=recipes`

Keyed by `recipe_id` rather than `product_id`:

```json
{"items": [{"recipe_id": 608, "quantity": -1, "delete": true}]}
```

## Authentication

### CSRF Token

All mutation requests require `X-CSRFToken` header. The token is in the `csrftoken` cookie, set on any page GET.

### Login

1. **GET** `https://oda.com/no/user/login/` to obtain the `csrftoken` cookie
2. **POST** `https://oda.com/api/v1/user/login/` with `Content-Type: application/json`:

   ```json
   {"username": "user@example.com", "password": "..."}
   ```

   - The email goes in `username`
   - Include `X-CSRFToken` and `Referer: https://oda.com/no/user/login/`
   - Success is a 2xx; the session arrives as cookies

### Check User

The `"user"` dehydrated query is present on all pages (when authenticated).
Note its `queryKey` is a plain string array (`["user"]`), not the
`[{_id: ...}]` form used by the search queries:

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

- Search and recipe data use **camelCase** field names (from React/Next.js)
- Cart REST API uses **snake_case** field names (Django backend)
- The `425 Too Early` status is returned when the server is overloaded
- Pagination is page-number based (`?page=2`), not cursor-based
- All requests need the `csrftoken` cookie — obtained from any GET request
- Cart `quantity` values are **deltas**, not absolute counts
- Recipe URLs redirect to a slug form (`/no/recipes/608` →
  `/no/recipes/608-oda-pizza-parma/`), so redirects must be followed
- Page requests need browser-like headers; a bare `curl` can be served a page
  with no hydration data at all
