/** Accept historical S3 configuration, but always use the official SDK's native endpoint. */
export const tosEndpoint = (endpoint: string, region: string): string => {
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
  return `tos-${region}.volces.com`;
};
