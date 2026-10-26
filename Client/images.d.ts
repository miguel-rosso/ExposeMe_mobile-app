// Metro resolves bundled image imports to a numeric asset id (what `require()` returns),
// which every React Native image `source` accepts as-is.
declare module "*.jpg" {
  const assetId: number;
  export default assetId;
}

declare module "*.jpeg" {
  const assetId: number;
  export default assetId;
}

declare module "*.png" {
  const assetId: number;
  export default assetId;
}
