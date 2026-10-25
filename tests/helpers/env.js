// Test defaults so `npm test` works against the local docker-compose database.
// CI overrides DATABASE_URL with its own Postgres service.
process.env.DATABASE_URL ||= "postgresql://bn:bn@localhost:5433/bn_smart";
process.env.JWT_SECRET ||= "test-secret-test-secret";
process.env.DEFAULT_ADMIN_PASSWORD ||= "Admin@12345";
process.env.NODE_ENV ||= "test";
