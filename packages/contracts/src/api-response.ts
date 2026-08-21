import type { ApiErrorCode } from './asset';

export type ApiResponse<T> = {
  success: boolean;
  data: T;
  message?: string;
  code?: ApiErrorCode;
  requestId?: string;
};

export type ApiErrorResponse = ApiResponse<null> & {
  success: false;
  message: string;
  code: ApiErrorCode;
};
