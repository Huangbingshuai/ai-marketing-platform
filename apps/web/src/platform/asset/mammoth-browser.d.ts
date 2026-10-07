declare module 'mammoth/mammoth.browser' {
  import type * as Mammoth from 'mammoth';
  const mammoth: Pick<typeof Mammoth, 'extractRawText'>;
  export default mammoth;
}
