import {ServerRouter} from 'react-router';
import {isbot} from 'isbot';
import {renderToReadableStream} from 'react-dom/server';
import {
  createContentSecurityPolicy,
  type HydrogenRouterContextProvider,
} from '@shopify/hydrogen';
import type {EntryContext} from 'react-router';

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext,
  context: HydrogenRouterContextProvider,
) {
  const {nonce, header, NonceProvider} = createContentSecurityPolicy({
    shop: {
      checkoutDomain: context.env.PUBLIC_CHECKOUT_DOMAIN,
      storeDomain: context.env.PUBLIC_STORE_DOMAIN,
    },
    // Same sources scripts fall back to by default, plus WebAssembly for the meshopt
    // decoder that unpacks the gallery's mannequin models ('wasm-unsafe-eval' allows
    // compiling wasm only, not JS eval). Hydrogen appends the nonce itself.
    scriptSrc: [
      "'self'",
      "'wasm-unsafe-eval'",
      'https://cdn.shopify.com',
      'https://shopify.com',
      ...(import.meta.env.DEV ? ['http://localhost:*'] : []),
    ],
    // Josefin Sans from Google Fonts, and 3D models fetched from the Shopify CDN
    styleSrc: ['https://fonts.googleapis.com'],
    fontSrc: ['https://fonts.gstatic.com'],
    // blob: is how GLTFLoader reads textures embedded in a GLB (the mannequin's hair)
    connectSrc: ['https://cdn.shopify.com', 'blob:'],
  });

  const body = await renderToReadableStream(
    <NonceProvider>
      <ServerRouter
        context={reactRouterContext}
        url={request.url}
        nonce={nonce}
      />
    </NonceProvider>,
    {
      nonce,
      signal: request.signal,
      onError(error) {
        console.error(error);
        responseStatusCode = 500;
      },
    },
  );

  if (isbot(request.headers.get('user-agent'))) {
    await body.allReady;
  }

  responseHeaders.set('Content-Type', 'text/html');
  responseHeaders.set('Content-Security-Policy', header);

  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
