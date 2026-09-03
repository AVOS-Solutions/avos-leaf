// Auth types mirror avos-leaf's own backend (Avos.Leaf.Api) — same "account cache, no password"
// shape as avos-vault's/avos-deck's frontend types.
export type UserSummary = {
  id: string;
  email: string;
  fullName: string;
};

export type AuthResponse = {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  account: UserSummary;
};

export type TwoFactorChallengeResponse = {
  requiresTwoFactor: true;
  challengeToken: string;
  challengeTokenExpiresAt: string;
};

export type FolderSummary = {
  id: string;
  name: string;
  parentFolderId: string | null;
  createdAt: string;
};

export type DocumentSummary = {
  id: string;
  name: string;
  folderId: string | null;
  sizeBytes: number;
  pageCount: number;
  starred: boolean;
  trashedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
