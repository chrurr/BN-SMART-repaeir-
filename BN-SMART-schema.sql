CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(80) UNIQUE NOT NULL,
  full_name VARCHAR(120) NOT NULL,
  phone VARCHAR(30),
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'collaborator',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  avatar TEXT,
  last_login TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customers (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  phone VARCHAR(30) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS repair_orders (
  id BIGSERIAL PRIMARY KEY,
  receipt_no INTEGER UNIQUE NOT NULL,
  tracking_code VARCHAR(30) UNIQUE NOT NULL,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  brand VARCHAR(80),
  model VARCHAR(120),
  color VARCHAR(60),
  power_state VARCHAR(30),
  fault TEXT,
  diagnosis TEXT,
  expected_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  part_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  labor_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
  supplier VARCHAR(80),
  status VARCHAR(40) NOT NULL DEFAULT 'قيد الاصلاح',
  accessories JSONB NOT NULL DEFAULT '[]'::jsonb,
  accessory_notes TEXT,
  notes TEXT,
  due_at TIMESTAMPTZ,
  customer_received BOOLEAN NOT NULL DEFAULT FALSE,
  received_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS repair_status_history (
  id BIGSERIAL PRIMARY KEY,
  repair_id BIGINT NOT NULL REFERENCES repair_orders(id) ON DELETE CASCADE,
  status VARCHAR(40) NOT NULL,
  changed_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id BIGSERIAL PRIMARY KEY,
  repair_id BIGINT NOT NULL REFERENCES repair_orders(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL,
  recorded_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS spare_parts (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  sku VARCHAR(80),
  quantity NUMERIC(12,2) NOT NULL DEFAULT 0,
  cost_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  sale_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS repair_parts (
  id BIGSERIAL PRIMARY KEY,
  repair_id BIGINT NOT NULL REFERENCES repair_orders(id) ON DELETE CASCADE,
  part_id BIGINT NOT NULL REFERENCES spare_parts(id),
  quantity NUMERIC(12,2) NOT NULL DEFAULT 1,
  unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  sale_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  added_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_transactions (
  id BIGSERIAL PRIMARY KEY,
  part_id BIGINT NOT NULL REFERENCES spare_parts(id),
  quantity_change NUMERIC(12,2) NOT NULL,
  type VARCHAR(30) NOT NULL,
  reference_id BIGINT,
  performed_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  repair_id BIGINT REFERENCES repair_orders(id) ON DELETE CASCADE,
  channel VARCHAR(30) NOT NULL DEFAULT 'whatsapp',
  message TEXT NOT NULL,
  sent_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id),
  action VARCHAR(120) NOT NULL,
  repair_id BIGINT REFERENCES repair_orders(id) ON DELETE SET NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repairs_status ON repair_orders(status);
CREATE INDEX IF NOT EXISTS idx_repairs_tracking ON repair_orders(tracking_code);
CREATE INDEX IF NOT EXISTS idx_repairs_customer ON repair_orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_logs(user_id);
