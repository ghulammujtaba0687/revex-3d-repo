import {useLoaderData} from 'react-router';
import type {Route} from './+types/_index';
import {MockShopNotice} from '~/components/MockShopNotice';
import {Gallery} from '~/components/gallery/Gallery';
import type {GalleryProduct} from '~/components/gallery/types';

export const meta: Route.MetaFunction = () => {
  return [
    {title: 'RAVEX | The 3D Gallery'},
    {
      name: 'description',
      content: 'Walk through the RAVEX 3D gallery and shop the collection piece by piece.',
    },
  ];
};

interface GalleryProductsQueryResult {
  products: {
    nodes: Array<{
      id: string;
      title: string;
      handle: string;
      productType: string;
      images: {nodes: Array<{url: string; altText: string | null}>};
      options: Array<{name: string; optionValues: Array<{name: string}>}>;
      priceRange: {minVariantPrice: {amount: string; currencyCode: string}};
      variants: {
        nodes: Array<{
          id: string;
          availableForSale: boolean;
          price: {amount: string; currencyCode: string};
          selectedOptions: Array<{name: string; value: string}>;
        }>;
      };
      media: {
        nodes: Array<{
          mediaContentType: string;
          sources?: Array<{url: string; format: string}>;
        }>;
      };
    }>;
  };
}

export async function loader({context}: Route.LoaderArgs) {
  const {products} = await context.storefront.query<GalleryProductsQueryResult>(
    GALLERY_PRODUCTS_QUERY,
    {variables: {first: 24}},
  );

  const galleryProducts: GalleryProduct[] = products.nodes.map((product) => {
    const model = product.media.nodes.find((m) => m.mediaContentType === 'MODEL_3D');
    const glb = model?.sources?.find((s) => s.format === 'glb');
    return {
      id: product.id,
      handle: product.handle,
      title: product.title,
      productType: product.productType || null,
      images: product.images.nodes,
      modelUrl: glb?.url ?? null,
      options: product.options.map((o) => ({
        name: o.name,
        values: o.optionValues.map((v) => v.name),
      })),
      variants: product.variants.nodes.map((v) => ({
        id: v.id,
        available: v.availableForSale,
        amount: v.price.amount,
        currencyCode: v.price.currencyCode,
        selectedOptions: v.selectedOptions,
      })),
      amount: product.priceRange.minVariantPrice.amount,
      currencyCode: product.priceRange.minVariantPrice.currencyCode,
    };
  });

  return {
    isShopLinked: Boolean(context.env.PUBLIC_STORE_DOMAIN),
    galleryProducts,
  };
}

export default function Homepage() {
  const data = useLoaderData<typeof loader>();
  return (
    <>
      {data.isShopLinked ? null : <MockShopNotice />}
      <Gallery products={data.galleryProducts} />
    </>
  );
}

const GALLERY_PRODUCTS_QUERY = `#graphql
  query GalleryProducts(
    $country: CountryCode
    $language: LanguageCode
    $first: Int
  ) @inContext(country: $country, language: $language) {
    products(first: $first, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id
        title
        handle
        productType
        images(first: 6) {
          nodes {
            url
            altText
          }
        }
        options {
          name
          optionValues {
            name
          }
        }
        priceRange {
          minVariantPrice {
            amount
            currencyCode
          }
        }
        variants(first: 50) {
          nodes {
            id
            availableForSale
            price {
              amount
              currencyCode
            }
            selectedOptions {
              name
              value
            }
          }
        }
        media(first: 10) {
          nodes {
            mediaContentType
            ... on Model3d {
              sources {
                url
                format
              }
            }
          }
        }
      }
    }
  }
` as const;
