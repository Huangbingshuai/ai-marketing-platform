import { SetMetadata } from '@nestjs/common';

export const AUTH_ACCESS = 'platform:auth-access';
/** Only for public infrastructure or endpoints that enforce their own Worker token/signature. */
export const AuthAccess = (mode: 'public' | 'independent') => SetMetadata(AUTH_ACCESS, mode);
