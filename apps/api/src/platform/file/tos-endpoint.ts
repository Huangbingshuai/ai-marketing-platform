/** TOS native and S3 endpoints are different; the existing client signs AWS S3 V4. */
export const tosS3Endpoint = (endpoint: string, region: string): string => {
  const parsed = new URL(endpoint.includes('://') ? endpoint : `https://${endpoint}`);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    !/^([a-z]+-)+[a-z0-9]+$/u.test(region) ||
    ![`tos-${region}.volces.com`, `tos-s3-${region}.volces.com`].includes(parsed.hostname)
  ) {
    throw new Error('TOS_ENDPOINT 必须是与 TOS_REGION 一致的外网 HTTPS 地域地址');
  }
  return `tos-s3-${region}.volces.com`;
};
