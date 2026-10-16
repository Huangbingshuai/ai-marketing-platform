export type LoginRequest = {
  username: string;
  password: string;
};

export type AuthSession = {
  username: string;
  expiresAt: string;
};
