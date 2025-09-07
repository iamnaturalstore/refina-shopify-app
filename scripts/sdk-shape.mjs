
import shopify from '../refina-backend/shopify.js';

const s = shopify;
const path =
  (s?.api?.clients?.Graphql && 'api.clients.Graphql') ||
  (s?.clients?.Graphql && 'clients.Graphql') ||
  'MISSING';

console.log({
  hasApi: !!s.api,
  hasApiClients: !!s?.api?.clients,
  hasClients: !!s.clients,
  graphqlClientPath: path,
});

try {
  const pkg = await import('@shopify/shopify-api/package.json');
  console.log({ shopifyApiVersion: pkg.version });
} catch (e) {
  console.log('Unable to read @shopify/shopify-api version:', String(e));
}
