export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };
export type MakeEmpty<T extends { [key: string]: unknown }, K extends keyof T> = { [_ in K]?: never };
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string; }
  String: { input: string; output: string; }
  Boolean: { input: boolean; output: boolean; }
  Int: { input: number; output: number; }
  Float: { input: number; output: number; }
  CurrencyCode: { input: any; output: any; }
  Decimal: { input: any; output: any; }
};

export type Cart = {
  __typename?: 'Cart';
  deliveryGroups: Array<CartDeliveryGroup>;
};

export type CartDeliveryGroup = {
  __typename?: 'CartDeliveryGroup';
  cartLines: Array<CartLine>;
  deliveryOptions: Array<CartDeliveryOption>;
  id: Scalars['ID']['output'];
};

export type CartDeliveryOption = {
  __typename?: 'CartDeliveryOption';
  cost: MoneyV2;
  handle: Scalars['String']['output'];
  title: Scalars['String']['output'];
};

export type CartLine = {
  __typename?: 'CartLine';
  cost: CartLineCost;
  merchandise: CartLineMerchandise;
};

export type CartLineCost = {
  __typename?: 'CartLineCost';
  subtotalAmount: MoneyV2;
};

export type CartLineMerchandise = ProductVariant;

export type DiscountNode = {
  __typename?: 'DiscountNode';
  metafield?: Maybe<Metafield>;
};


export type DiscountNodeMetafieldArgs = {
  key: Scalars['String']['input'];
  namespace: Scalars['String']['input'];
};

export type Metafield = {
  __typename?: 'Metafield';
  value: Scalars['String']['output'];
};

export type MoneyV2 = {
  __typename?: 'MoneyV2';
  amount: Scalars['Decimal']['output'];
  currencyCode: Scalars['CurrencyCode']['output'];
};

export type Product = {
  __typename?: 'Product';
  vendor: Scalars['String']['output'];
};

export type ProductVariant = {
  __typename?: 'ProductVariant';
  product: Product;
};

export type Query = {
  __typename?: 'Query';
  cart: Cart;
  discountNode: DiscountNode;
};

export type RunInputQueryVariables = Exact<{ [key: string]: never; }>;


export type RunInputQuery = { __typename?: 'Query', cart: { __typename?: 'Cart', deliveryGroups: Array<{ __typename?: 'CartDeliveryGroup', id: string, deliveryOptions: Array<{ __typename?: 'CartDeliveryOption', handle: string, title: string, cost: { __typename?: 'MoneyV2', amount: any, currencyCode: any } }>, cartLines: Array<{ __typename?: 'CartLine', cost: { __typename?: 'CartLineCost', subtotalAmount: { __typename?: 'MoneyV2', amount: any, currencyCode: any } }, merchandise: { __typename: 'ProductVariant', product: { __typename?: 'Product', vendor: string } } }> }> }, discountNode: { __typename?: 'DiscountNode', metafield?: { __typename?: 'Metafield', value: string } | null } };
