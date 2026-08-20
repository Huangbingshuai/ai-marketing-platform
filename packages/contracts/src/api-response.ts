export type ApiResponse<T> = {
  success: boolean;
  data: T;
  message?: string;
  requestId?: string;
};

export type ApiErrorResponse = ApiResponse<null> & {
  success: false;
  message: string;
};
