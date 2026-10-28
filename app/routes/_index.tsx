import {useLoaderData} from 'react-router';
import type {Route} from './+types/_index';
import {MockShopNotice} from '~/components/MockShopNotice';
import {Gallery, type GalleryProduct} from '~/components/gallery/Gallery';

export const meta: Route.MetaFunction = () => {
  return [{title: 'Hydrogen | Gallery'}];
};

interface GalleryProductsQueryResult {
  shop: {name: string};
  products: {
    nodes: Array<{
      id: string;
      title: string;
      handle: string;
      featuredImage: {url: string; altText: string | null} | null;
      priceRange: {
        minVariantPrice: {amount: string; currencyCode: string};
      };
      variants: {
        nodes: Array<{id: string; availableForSale: boolean}>;
      };
    }>;
  };
}

export async function loader({context}: Route.LoaderArgs) {
  const isShopLinked = Boolean(context.env.PUBLIC_STORE_DOMAIN);

  const {products, shop} = await context.storefront.query<GalleryProductsQueryResult>(
    GALLERY_PRODUCTS_QUERY,
    {variables: {first: 24}},
  );

  const galleryProducts: GalleryProduct[] = products.nodes.map((product) => ({
    id: product.id,
    handle: product.handle,
    title: product.title,
    imageUrl: product.featuredImage?.url ?? null,
    imageAlt: product.featuredImage?.altText ?? null,
    amount: product.priceRange.minVariantPrice.amount,
    currencyCode: product.priceRange.minVariantPrice.currencyCode,
    variantId: product.variants.nodes[0]?.id ?? null,
    available: product.variants.nodes[0]?.availableForSale ?? false,
  }));

  return {
    isShopLinked,
    shopName: shop?.name ?? 'Gallery',
    galleryProducts,
  };
}

export default function Homepage() {
  const data = useLoaderData<typeof loader>();
  return (
    <>
      {data.isShopLinked ? null : <MockShopNotice />}
      <Gallery products={data.galleryProducts} shopName={data.shopName} />
    </>
  );
}

const GALLERY_PRODUCTS_QUERY = `#graphql
  query GalleryProducts(
    $country: CountryCode
    $language: LanguageCode
    $first: Int
  ) @inContext(country: $country, language: $language) {
    shop {
      name
    }
    products(first: $first, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id
        title
        handle
        featuredImage {
          url
          altText
          width
          height
        }
        priceRange {
          minVariantPrice {
            amount
            currencyCode
          }
        }
        variants(first: 1) {
          nodes {
            id
            availableForSale
          }
        }
      }
    }
  }
` as const;
