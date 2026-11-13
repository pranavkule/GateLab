const mongoose = require('mongoose');

// A routing configuration version. The active config is the doc with the
// highest version. Gateways cache it in memory and replace it atomically.
const RouteConfigSchema = new mongoose.Schema(
  {
    version: { type: Number, required: true, unique: true, index: true },
    routes: [
      {
        _id: false,
        id: { type: String, required: true },
        path: { type: String, required: true },        // e.g. /api/users/*
        targetService: { type: String, required: true }, // users | products | orders
        authRequired: { type: Boolean, default: true },
        enabled: { type: Boolean, default: true },
        // Optional shared fixed-window rate limit. Absent/null = unlimited.
        rateLimit: {
          _id: false,
          limit: { type: Number, min: 1 },
          windowMs: { type: Number, min: 1000, max: 3600000 },
        },
      },
    ],
    appliedAt: { type: Date, default: Date.now },
    appliedBy: { type: String, default: 'admin' },
  },
  { timestamps: true }
);

// Audit trail of every configuration change.
const ConfigAuditSchema = new mongoose.Schema(
  {
    version: Number,
    action: { type: String, enum: ['create', 'update', 'seed'] },
    changedBy: { type: String, default: 'admin' },
    summary: String,
    routes: mongoose.Schema.Types.Mixed,
    createdAt: { type: Date, default: Date.now },
  }
);

// Persisted request log (written asynchronously in batches by the control plane).
const RequestLogSchema = new mongoose.Schema(
  {
    timestamp: { type: Date, default: Date.now, index: true },
    method: String,
    path: String,
    gateway: String,        // e.g. gateway-3001 | entry-lb
    backendService: String, // users | products | orders | none
    backendInstance: String,// e.g. 4001 | none
    jwtStatus: { type: String, enum: ['valid', 'missing', 'invalid', 'expired', 'none'] },
    status: Number,
    latencyMs: Number,
    error: String,
    rateLimited: { type: Boolean, default: false }, // true when the gateway answered 429 (P2.4)
  }
);
RequestLogSchema.index({ timestamp: -1 });

// Demo users for the login flow.
const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password: String, // demo only - plain text on purpose for a teaching lab
  role: { type: String, default: 'student' },
});

// ---------------------------------------------------------------------------
// Application-layer (e-commerce) domain models.
// These are owned by the microservices, not by the auth service: the demo
// `User` model above stays the auth-service login store, while `UserProfile`
// holds real customer accounts with scrypt-hashed passwords.
// ---------------------------------------------------------------------------

// E-commerce user account + profile information. Passwords are NEVER stored
// in plain text - only scrypt hashes produced by backend/utils/password.js.
const UserProfileSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['customer', 'admin'], default: 'customer' },
    phone: { type: String, trim: true },
    address: {
      _id: false,
      line1: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      postalCode: { type: String, trim: true },
      country: { type: String, trim: true, default: 'India' },
    },
  },
  { timestamps: true }
);
UserProfileSchema.index({ role: 1 });

// Product catalog. `price` is in major currency units; orders snapshot the
// price at purchase time so later catalog changes never rewrite history.
// optimisticConcurrency lets P1.2 use atomic $inc inventory updates safely
// under concurrent order placement.
const ProductSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: '' },
    price: { type: Number, required: true, min: 0 },
    category: { type: String, required: true, trim: true },
    stock: { type: Number, required: true, min: 0, default: 0 },
    status: { type: String, enum: ['active', 'inactive', 'discontinued'], default: 'active' },
  },
  { timestamps: true, optimisticConcurrency: true }
);
ProductSchema.index({ status: 1, category: 1 });

// Order placed by a user. Each line item preserves the PURCHASE-TIME product
// name and price (snapshot), so catalog edits never corrupt order history.
// clientRequestId is an OPTIONAL idempotency key: re-submitting the same
// request (same user + same key) returns the existing order instead of
// creating a duplicate and deducting stock twice (compound unique index).
const OrderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'UserProfile', required: true },
    items: [
      {
        _id: false,
        product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
        name: { type: String, required: true },            // purchase-time snapshot
        price: { type: Number, required: true, min: 0 },   // purchase-time snapshot
        quantity: { type: Number, required: true, min: 1 },
      },
    ],
    totalAmount: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'], default: 'pending' },
    clientRequestId: { type: String, trim: true, maxlength: 64 },
  },
  { timestamps: true }
);
OrderSchema.index({ user: 1, createdAt: -1 });
OrderSchema.index({ status: 1 });
// Idempotency: at most one order per (user, clientRequestId). The partial
// filter only indexes orders that actually HAVE a string key - MongoDB's
// sparse option would still index nulls (mongoose stores absent optional
// fields as null), causing false duplicate-key errors.
OrderSchema.index(
  { user: 1, clientRequestId: 1 },
  { unique: true, partialFilterExpression: { clientRequestId: { $type: 'string' } } }
);

const RouteConfig = mongoose.models.RouteConfig || mongoose.model('RouteConfig', RouteConfigSchema);
const ConfigAudit = mongoose.models.ConfigAudit || mongoose.model('ConfigAudit', ConfigAuditSchema);
const RequestLog = mongoose.models.RequestLog || mongoose.model('RequestLog', RequestLogSchema);
const User = mongoose.models.User || mongoose.model('User', UserSchema);
const UserProfile = mongoose.models.UserProfile || mongoose.model('UserProfile', UserProfileSchema);
const Product = mongoose.models.Product || mongoose.model('Product', ProductSchema);
const Order = mongoose.models.Order || mongoose.model('Order', OrderSchema);

module.exports = { RouteConfig, ConfigAudit, RequestLog, User, UserProfile, Product, Order };
