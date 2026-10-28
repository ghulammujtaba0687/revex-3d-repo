export interface GalleryVariant {
  id: string;
  available: boolean;
  amount: string;
  currencyCode: string;
  selectedOptions: {name: string; value: string}[];
}

export interface GalleryProduct {
  id: string;
  handle: string;
  title: string;
  productType: string | null;
  images: {url: string; altText: string | null}[];
  /** GLB from the product's 3D model media in Shopify, if one was uploaded. */
  modelUrl: string | null;
  options: {name: string; values: string[]}[];
  variants: GalleryVariant[];
  amount: string;
  currencyCode: string;
}

export type Gender = 'women' | 'men';
