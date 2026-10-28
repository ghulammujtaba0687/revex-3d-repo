# revex-3d-storefront

Headless Shopify storefront built with [Hydrogen](https://shopify.dev/custom-storefronts/hydrogen) (React Router + Vite), deployed on Shopify Oxygen.

## Stack

- Hydrogen (React Router, TypeScript)
- Tailwind CSS
- Oxygen (hosting, auto-deployed via GitHub Actions on push to `main`)

## Local development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Link this project to the `revex-3d-storefront` storefront and pull environment variables:

   ```bash
   npx shopify hydrogen link
   npx shopify hydrogen env pull
   ```

3. Start the dev server:

   ```bash
   npm run dev
   ```

## Deployment

Pushes to `main` deploy automatically to production via the Oxygen GitHub Actions workflow. Pushes to other branches deploy to preview environments.
