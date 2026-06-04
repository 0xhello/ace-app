export const isLocalAuthBypassEnabled =
  process.env.NODE_ENV === "development" && process.env.ACE_REQUIRE_LOCAL_AUTH !== "1";

export const devUser = {
  id: "0",
  email: "local-dev@ace.local",
  role: "admin",
};

export const devSession = {
  user: devUser,
};
