/** Riverside OS governed Cube Core configuration. */
module.exports = {
  queryRewrite: (query) => ({
    ...query,
    limit: Math.min(Math.max(Number(query.limit) || 500, 1), 500),
    timezone: query.timezone || "America/New_York",
  }),
};
